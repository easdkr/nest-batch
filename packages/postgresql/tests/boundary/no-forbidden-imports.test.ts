import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/postgresql/tests/boundary -> packages/postgresql/tests
// -> packages/postgresql -> packages/  (so '..' x 3 = packages/)
// packages/ -> nest-batch/  (so one more '..' to repo root)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * T-AC-2b — Postgres provider boundary test, owned by `@nest-batch/postgresql`.
 *
 * This is the T-AC-2b final form: the test lives inside the Postgres
 * sibling package and asserts the inverse of the
 * `no-postgres-in-existing-packages.test.ts` core test — it scans
 * the 8 non-Postgres packages and asserts that no Postgres driver
 * import / peer dep / env literal / prisma schema with
 * `provider = "postgresql"` has leaked into them.
 *
 * Scans `src/**` and `package.json` ONLY. Does NOT scan `dist/**`
 * (build artifacts may carry stale strings) and does NOT scan
 * `README.md` (prose mentions are not a contract). Prisma's
 * `prisma/schema.prisma` is also scanned for the `postgresql`
 * provider — that is part of the source contract for the prisma
 * package.
 */

const NON_POSTGRES_PACKAGES: readonly string[] = [
  'core',
  'mikro-orm',
  'typeorm',
  'bullmq',
  'drizzle',
  'prisma',
  'kafka',
  'webhook',
  'mysql',
];

const POSTGRES_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]*(?:\bpg\b|@mikro-orm\/postgresql|@nestjs\/typeorm|drizzle-orm\/pg-core|drizzle-orm\/node-postgres)[^'"]*)['"]/g;

const POSTGRES_ENV_RE = /\bPOSTGRES_[A-Z_]+\b/g;

const DEP_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const POSTGRES_DEP_KEY_SUBSTRINGS: readonly string[] = [
  '@mikro-orm/postgresql',
  '@nestjs/typeorm',
  'drizzle-orm/pg-core',
  'drizzle-orm/node-postgres',
];

function* walkTypeScriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTypeScriptFiles(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

interface PackageViolation {
  packageName: string;
  source: 'src-import' | 'package-json' | 'src-env' | 'prisma-schema';
  detail: string;
  file: string;
}

function findPostgresSpecifiersInSource(srcRoot: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  for (const file of walkTypeScriptFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    const text = readFileSync(file, 'utf8');
    POSTGRES_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = POSTGRES_SPEC_RE.exec(text)) !== null) {
      violations.push({
        packageName: '',
        source: 'src-import',
        detail: `imports "${match[1]}" (Postgres specifier)`,
        file: rel,
      });
    }
  }
  return violations;
}

function findPostgresInPackageJson(pkgJsonPath: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  const text = readFileSync(pkgJsonPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return violations;
  }
  if (typeof parsed !== 'object' || parsed === null) return violations;
  const obj = parsed as Record<string, unknown>;
  for (const field of DEP_FIELDS) {
    const deps = obj[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const key of Object.keys(deps as Record<string, unknown>)) {
      if (POSTGRES_DEP_KEY_SUBSTRINGS.some((s) => key.includes(s))) {
        violations.push({
          packageName: '',
          source: 'package-json',
          detail: `"${field}" contains key "${key}"`,
          file: `package.json#${field}`,
        });
      }
    }
  }
  return violations;
}

function findPostgresEnvLiteralsInSource(srcRoot: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  for (const file of walkTypeScriptFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    const text = readFileSync(file, 'utf8');
    POSTGRES_ENV_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = POSTGRES_ENV_RE.exec(text)) !== null) {
      violations.push({
        packageName: '',
        source: 'src-env',
        detail: `contains "${match[0]}" env-var name literal`,
        file: rel,
      });
    }
  }
  return violations;
}

function findPostgresProviderInPrismaSchema(pkgRoot: string): PackageViolation[] {
  const schemaPath = join(pkgRoot, 'prisma', 'schema.prisma');
  if (!existsSync(schemaPath)) return [];
  const text = readFileSync(schemaPath, 'utf8');
  const m = text.match(/provider\s*=\s*["']postgresql["']/);
  if (!m) return [];
  return [
    {
      packageName: '',
      source: 'prisma-schema',
      detail: `declares "provider = \"postgresql\""`,
      file: 'prisma/schema.prisma',
    },
  ];
}

describe('dependency boundary: no Postgres drivers in non-Postgres packages (postgresql-side watchlist)', () => {
  const allViolations: PackageViolation[] = [];
  const scannedPackages: { pkg: string; srcExists: boolean }[] = [];

  for (const pkg of NON_POSTGRES_PACKAGES) {
    const pkgRoot = join(REPO_ROOT, 'packages', pkg);
    if (!existsSync(pkgRoot)) {
      scannedPackages.push({ pkg, srcExists: false });
      continue;
    }
    scannedPackages.push({ pkg, srcExists: true });

    const srcRoot = join(pkgRoot, 'src');
    const pkgJsonPath = join(pkgRoot, 'package.json');

    if (existsSync(srcRoot)) {
      for (const v of findPostgresSpecifiersInSource(srcRoot)) {
        allViolations.push({ ...v, packageName: pkg });
      }
      for (const v of findPostgresEnvLiteralsInSource(srcRoot)) {
        allViolations.push({ ...v, packageName: pkg });
      }
    }
    if (existsSync(pkgJsonPath)) {
      for (const v of findPostgresInPackageJson(pkgJsonPath)) {
        allViolations.push({ ...v, packageName: pkg });
      }
    }
    for (const v of findPostgresProviderInPrismaSchema(pkgRoot)) {
      allViolations.push({ ...v, packageName: pkg });
    }
  }

  it('scans every existing non-Postgres package (sanity check)', () => {
    const present = scannedPackages.filter((s) => s.srcExists).map((s) => s.pkg);
    expect(present).toEqual(
      expect.arrayContaining(['core', 'mikro-orm', 'typeorm', 'drizzle', 'prisma']),
    );
  });

  it('contains no Postgres driver imports, peer deps, env literals, or prisma schemas in any non-Postgres package', () => {
    if (allViolations.length > 0) {
      const detail = allViolations
        .map(
          (v) =>
            `  - packages/${v.packageName}/${v.file}: ${v.source} — ${v.detail}`,
        )
        .join('\n');
      throw new Error(
        `Postgres driver leak detected in a non-Postgres package:\n${detail}\n\n` +
          `Postgres drivers belong in @nest-batch/postgresql. ` +
          `Sibling packages must stay driver-agnostic.`,
      );
    }
    expect(allViolations).toEqual([]);
  });

  it('the watchlist covers every known non-Postgres sibling (guardrail)', () => {
    expect(NON_POSTGRES_PACKAGES).toEqual(
      expect.arrayContaining([
        'core',
        'mikro-orm',
        'typeorm',
        'bullmq',
        'drizzle',
        'prisma',
        'kafka',
        'webhook',
        'mysql',
      ]),
    );
  });
});
