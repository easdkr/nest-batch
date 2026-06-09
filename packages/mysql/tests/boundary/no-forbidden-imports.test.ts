import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/mysql/tests/boundary -> packages/mysql/tests -> packages/mysql
// -> packages/  (so '..' x 3 = packages/)
// packages/ -> nest-batch/  (so one more '..' to repo root)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * T-AC-2 — MySQL provider boundary test, owned by `@nest-batch/mysql`.
 *
 * This is the T-AC-2 final form: the test lives inside the MySQL
 * sibling package and asserts the inverse of the
 * `no-mysql-in-existing-packages.test.ts` core test — it scans the
 * 8 non-MySQL packages and asserts that no MySQL driver import /
 * peer dep / env literal / prisma schema with `provider = "mysql"`
 * has leaked into them.
 *
 * The two tests are complementary:
 *
 *   - `packages/core/tests/core/boundary/no-mysql-in-existing-packages.test.ts`
 *     is the **core-side** watchlist (the canonical guardrail that
 *     blocks a regression in any of the 8 non-MySQL packages).
 *   - `packages/mysql/tests/boundary/no-forbidden-imports.test.ts`
 *     is the **mysql-side** watchlist (this file). It re-scans the
 *     same 8 packages from inside the MySQL sibling, so a
 *     future edit that adds a MySQL provider to one of the 8
 *     non-MySQL packages fails the boundary test from BOTH
 *     directions.
 *
 * Scans `src/**` and `package.json` ONLY. Does NOT scan `dist/**`
 * (build artifacts may carry stale strings) and does NOT scan
 * `README.md` (prose mentions are not a contract). Prisma's
 * `prisma/schema.prisma` is also scanned for the `mysql` provider —
 * that is part of the source contract for the prisma package.
 */

const NON_MYSQL_PACKAGES: readonly string[] = [
  'core',
  'mikro-orm',
  'typeorm',
  'bullmq',
  'drizzle',
  'prisma',
  'kafka',
  'webhook',
];

const MYSQL_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]*(?:\bmysql\b|\bmysql2\b|@mysql\/|drizzle-orm\/mysql-core|drizzle-orm\/mysql2)[^'"]*)['"]/g;

const MYSQL_ENV_RE = /\bMYSQL_[A-Z_]+\b/g;

const DEP_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const MYSQL_DEP_KEY_SUBSTRINGS: readonly string[] = [
  'mysql2',
  '@mikro-orm/mysql',
  'drizzle-orm/mysql',
  '@nestjs/typeorm-mysql',
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

function findMySqlSpecifiersInSource(srcRoot: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  for (const file of walkTypeScriptFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    const text = readFileSync(file, 'utf8');
    MYSQL_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MYSQL_SPEC_RE.exec(text)) !== null) {
      violations.push({
        packageName: '',
        source: 'src-import',
        detail: `imports "${match[1]}" (mysql specifier)`,
        file: rel,
      });
    }
  }
  return violations;
}

function findMySqlInPackageJson(pkgJsonPath: string): PackageViolation[] {
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
      if (
        key === 'mysql' ||
        key === 'mysql2' ||
        key.startsWith('@mysql/') ||
        MYSQL_DEP_KEY_SUBSTRINGS.some((s) => key.includes(s))
      ) {
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

function findMySqlEnvLiteralsInSource(srcRoot: string): PackageViolation[] {
  const violations: PackageViolation[] = [];
  for (const file of walkTypeScriptFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    const text = readFileSync(file, 'utf8');
    MYSQL_ENV_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MYSQL_ENV_RE.exec(text)) !== null) {
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

function findMySqlProviderInPrismaSchema(pkgRoot: string): PackageViolation[] {
  const schemaPath = join(pkgRoot, 'prisma', 'schema.prisma');
  if (!existsSync(schemaPath)) return [];
  const text = readFileSync(schemaPath, 'utf8');
  // Match `provider = "mysql"` (or single-quoted) in a Prisma datasource
  // block. The whitespace / casing is fixed by the Prisma grammar.
  const m = text.match(/provider\s*=\s*["']mysql["']/);
  if (!m) return [];
  return [
    {
      packageName: '',
      source: 'prisma-schema',
      detail: `declares "provider = \"mysql\""`,
      file: 'prisma/schema.prisma',
    },
  ];
}

describe('dependency boundary: no MySQL drivers in non-MySQL packages (mysql-side watchlist)', () => {
  const allViolations: PackageViolation[] = [];
  const scannedPackages: { pkg: string; srcExists: boolean }[] = [];

  for (const pkg of NON_MYSQL_PACKAGES) {
    const pkgRoot = join(REPO_ROOT, 'packages', pkg);
    if (!existsSync(pkgRoot)) {
      scannedPackages.push({ pkg, srcExists: false });
      continue;
    }
    scannedPackages.push({ pkg, srcExists: true });

    const srcRoot = join(pkgRoot, 'src');
    const pkgJsonPath = join(pkgRoot, 'package.json');

    if (existsSync(srcRoot)) {
      for (const v of findMySqlSpecifiersInSource(srcRoot)) {
        allViolations.push({ ...v, packageName: pkg });
      }
      for (const v of findMySqlEnvLiteralsInSource(srcRoot)) {
        allViolations.push({ ...v, packageName: pkg });
      }
    }
    if (existsSync(pkgJsonPath)) {
      for (const v of findMySqlInPackageJson(pkgJsonPath)) {
        allViolations.push({ ...v, packageName: pkg });
      }
    }
    for (const v of findMySqlProviderInPrismaSchema(pkgRoot)) {
      allViolations.push({ ...v, packageName: pkg });
    }
  }

  it('scans every existing non-MySQL package (sanity check)', () => {
    const present = scannedPackages.filter((s) => s.srcExists).map((s) => s.pkg);
    expect(present).toEqual(
      expect.arrayContaining(['core', 'mikro-orm', 'typeorm', 'drizzle', 'prisma']),
    );
  });

  it('contains no MySQL driver imports, peer deps, env literals, or prisma schemas in any non-MySQL package', () => {
    if (allViolations.length > 0) {
      const detail = allViolations
        .map(
          (v) =>
            `  - packages/${v.packageName}/${v.file}: ${v.source} — ${v.detail}`,
        )
        .join('\n');
      throw new Error(
        `MySQL driver leak detected in a non-MySQL package:\n${detail}\n\n` +
          `MySQL drivers belong in @nest-batch/mysql. ` +
          `Sibling packages must stay driver-agnostic.`,
      );
    }
    expect(allViolations).toEqual([]);
  });

  it('the watchlist covers every known non-MySQL sibling (guardrail)', () => {
    expect(NON_MYSQL_PACKAGES).toEqual(
      expect.arrayContaining([
        'core',
        'mikro-orm',
        'typeorm',
        'bullmq',
        'drizzle',
        'prisma',
        'kafka',
        'webhook',
      ]),
    );
  });
});
