import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/core/tests/core/boundary -> packages/ (4 levels up) -> REPO_ROOT
// boundary/ -> core/ -> tests/ -> core/ -> packages/  (so '..' x 4 = packages/)
// packages/ -> nest-batch/  (so one more '..' to repo root)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/**
 * T-AC-2b — Postgres provider boundary test.
 *
 * This test is RED on `main` (commit 02336ef / the post-`#2` refactor):
 * the 4 existing DB-adapter packages (`mikro-orm`, `typeorm`,
 * `drizzle`, `prisma`) each still declare Postgres provider peer
 * deps (`@mikro-orm/postgresql`, `@nestjs/typeorm`, `drizzle-orm`,
 * `prisma` with `provider = "postgresql"`). The test turns GREEN
 * after T10a's refactor in `.omo/plans/not-in-this-release.md`
 * (the 4 packages become driver-agnostic slots; Postgres providers
 * move to `@nest-batch/postgresql`).
 *
 * DO NOT mark this test as `it.skip` or `it.todo` — the RED
 * state is the spec, not a bug to suppress.
 *
 * Scans `src/**` and `package.json` ONLY. Does NOT scan `dist/**`
 * (build artifacts may carry stale strings) and does NOT scan
 * `README.md` (prose mentions are not a contract). Prisma's
 * `prisma/schema.prisma` is also scanned for the `postgresql`
 * provider — that is part of the source contract for the prisma
 * package.
 */

// Packages that must NOT contain Postgres providers.
// `mysql` / `postgresql` siblings are not yet shipped — the test
// is defensive and skips them gracefully if the directory is
// missing. `nest-batch` is the pre-rename legacy package and is
// excluded entirely.
const NON_POSTGRES_PACKAGES: readonly string[] = [
  'core',
  'mikro-orm',
  'typeorm',
  'bullmq',
  'drizzle',
  'prisma',
  'kafka',
  'mysql',
];

/**
 * Specifier patterns that imply a Postgres provider.
 *  - `pg` (bare `pg` driver) — note: `pg-` prefixed test names
 *    are blocked by the substring check on package.json, not by
 *    this regex.
 *  - `@mikro-orm/postgresql`
 *  - `@nestjs/typeorm` (carries the Postgres driver)
 *  - `drizzle-orm/pg-core`
 *  - `drizzle-orm/node-postgres`
 */
const POSTGRES_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]*(?:\bpg\b|@mikro-orm\/postgresql|@nestjs\/typeorm|drizzle-orm\/pg-core|drizzle-orm\/node-postgres)[^'"]*)['"]/g;

/** `POSTGRES_FOO_BAR` env-var-name string literal pattern. */
const POSTGRES_ENV_RE = /\bPOSTGRES_[A-Z_]+\b/g;

const DEP_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Substrings in `package.json` dep keys that imply a Postgres
 * provider. The check is on the *key* (package name), not the
 * value (semver range).
 */
const POSTGRES_DEP_KEY_SUBSTRINGS: readonly string[] = [
  'pg-core',
  'postgresql',
  '@nestjs/typeorm',
  // `drizzle-orm` is the umbrella package; we also block it
  // because the Postgres-specific bits (`drizzle-orm/pg-core`)
  // come from it. The boundary test in core already blocks
  // `drizzle-orm` outright; this substring check enforces the
  // same rule at the dep level for the adapter packages.
  'drizzle-orm',
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
  source:
    | 'src-import'
    | 'package-json'
    | 'src-env'
    | 'prisma-schema'
    | 'prisma-schema-missing';
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
      for (const needle of POSTGRES_DEP_KEY_SUBSTRINGS) {
        if (key.includes(needle)) {
          violations.push({
            packageName: '',
            source: 'package-json',
            detail: `"${field}" contains key "${key}" (matches substring "${needle}")`,
            file: `package.json#${field}`,
          });
          break;
        }
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

function findPostgresInPrismaSchema(prismaSchemaPath: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  const text = readFileSync(prismaSchemaPath, 'utf8');
  // Match `provider = "postgresql"` (whitespace tolerant).
  const providerRe = /provider\s*=\s*["']postgresql["']/g;
  let match: RegExpExecArray | null;
  while ((match = providerRe.exec(text)) !== null) {
    violations.push({
      packageName: '',
      source: 'prisma-schema',
      detail: `declares "${match[0]}"`,
      file: relative(REPO_ROOT, prismaSchemaPath),
    });
  }
  return violations;
}

describe('dependency boundary: no Postgres providers in non-Postgres packages', () => {
  const allViolations: PackageViolation[] = [];
  const scannedPackages: { pkg: string; srcExists: boolean }[] = [];

  for (const pkg of NON_POSTGRES_PACKAGES) {
    const pkgRoot = join(REPO_ROOT, 'packages', pkg);
    if (!existsSync(pkgRoot)) {
      // Sibling not yet shipped (mysql, postgresql). Skip silently.
      scannedPackages.push({ pkg, srcExists: false });
      continue;
    }
    scannedPackages.push({ pkg, srcExists: true });

    const srcRoot = join(pkgRoot, 'src');
    const pkgJsonPath = join(pkgRoot, 'package.json');
    const prismaSchemaPath = join(pkgRoot, 'prisma', 'schema.prisma');

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
    if (existsSync(prismaSchemaPath)) {
      for (const v of findPostgresInPrismaSchema(prismaSchemaPath)) {
        allViolations.push({ ...v, packageName: pkg });
      }
    }
  }

  it('scans every existing non-Postgres package (sanity check)', () => {
    const present = scannedPackages.filter((s) => s.srcExists).map((s) => s.pkg);
    expect(present).toEqual(
      expect.arrayContaining(['core', 'mikro-orm', 'typeorm', 'drizzle', 'prisma']),
    );
  });

  it('contains no Postgres provider imports, peer deps, env literals, or prisma schemas in any non-Postgres package', () => {
    if (allViolations.length > 0) {
      const detail = allViolations
        .map(
          (v) =>
            `  - packages/${v.packageName}/${v.file}: ${v.source} — ${v.detail}`,
        )
        .join('\n');
      throw new Error(
        `Postgres provider leak detected in a non-Postgres package:\n${detail}\n\n` +
          `Postgres providers belong in @nest-batch/postgresql (not yet shipped). ` +
          `Sibling DB-adapter packages must become driver-agnostic slots.`,
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
      ]),
    );
  });
});
