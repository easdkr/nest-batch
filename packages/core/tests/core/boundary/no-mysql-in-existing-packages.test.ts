import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/core/tests/core/boundary -> packages/ (4 levels up) -> REPO_ROOT
// boundary/ -> core/ -> tests/ -> core/ -> packages/  (so '..' x 4 = packages/)
// packages/ -> nest-batch/  (so one more '..' to repo root)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/**
 * T-AC-2 — MySQL provider boundary test.
 *
 * No non-MySQL package in this workspace may import or depend on a
 * MySQL driver. The MySQL sibling (`@nest-batch/mysql`, not yet
 * shipped) is the only place MySQL strings are allowed.
 *
 * This test is GREEN on `main` (commit 02336ef / the post-`#2`
 * refactor): no MySQL imports or peer deps exist in any of the
 * non-MySQL packages today. It stays GREEN through T10
 * (mysql sibling adds itself, not others).
 *
 * Scans `src/**` and `package.json` ONLY. Does NOT scan `dist/**`
 * (build artifacts may carry stale strings) and does NOT scan
 * `README.md` (prose mentions are not a contract).
 */

// Packages that must NOT contain MySQL drivers.
// `mysql` / `postgresql` siblings are not yet shipped — the test
// is defensive and skips them gracefully if the directory is
// missing. `nest-batch` is the pre-rename legacy package and is
// excluded entirely.
const NON_MYSQL_PACKAGES: readonly string[] = [
  'core',
  'mikro-orm',
  'typeorm',
  'bullmq',
  'drizzle',
  'prisma',
  'kafka',
  'postgresql',
];

/**
 * Import / require specifier regex. Captures the package spec from:
 *  - `import x from 'pkg'`
 *  - `import { y } from 'pkg'`
 *  - `import * as z from 'pkg'`
 *  - `import 'pkg'` (side-effect)
 *  - `await import('pkg')` (dynamic)
 *  - `require('pkg')`
 */
const IMPORT_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

/** MySQL specifier regex: matches `mysql`, `mysql2`, or any `@mysql/...`. */
const MYSQL_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]*(?:mysql|mysql2|@mysql\/)[^'"]*)['"]/g;

/** `MYSQL_FOO_BAR` env-var-name string literal pattern. */
const MYSQL_ENV_RE = /\bMYSQL_[A-Z_]+\b/g;

const DEP_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
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
  source: 'src-import' | 'package-json' | 'src-env' | 'src-mysql-path';
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
  } catch (err) {
    // If package.json is malformed the test should not be the
    // thing that surfaces it — let other tooling handle that.
    return violations;
  }
  if (typeof parsed !== 'object' || parsed === null) return violations;
  const obj = parsed as Record<string, unknown>;
  for (const field of DEP_FIELDS) {
    const deps = obj[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const key of Object.keys(deps as Record<string, unknown>)) {
      if (key === 'mysql' || key === 'mysql2' || key.startsWith('@mysql/')) {
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

describe('dependency boundary: no MySQL drivers in non-MySQL packages', () => {
  const allViolations: PackageViolation[] = [];
  const scannedPackages: { pkg: string; srcExists: boolean }[] = [];

  for (const pkg of NON_MYSQL_PACKAGES) {
    const pkgRoot = join(REPO_ROOT, 'packages', pkg);
    if (!existsSync(pkgRoot)) {
      // Sibling not yet shipped (mysql, postgresql). Skip silently.
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
  }

  it('scans every existing non-MySQL package (sanity check)', () => {
    // At least core + the 4 DB-adapter packages must exist on main.
    const present = scannedPackages.filter((s) => s.srcExists).map((s) => s.pkg);
    expect(present).toEqual(
      expect.arrayContaining(['core', 'mikro-orm', 'typeorm', 'drizzle', 'prisma']),
    );
  });

  it('contains no MySQL driver imports, peer deps, or env literals in any non-MySQL package', () => {
    if (allViolations.length > 0) {
      const detail = allViolations
        .map(
          (v) =>
            `  - packages/${v.packageName}/${v.file}: ${v.source} — ${v.detail}`,
        )
        .join('\n');
      throw new Error(
        `MySQL driver leak detected in a non-MySQL package:\n${detail}\n\n` +
          `MySQL drivers belong in @nest-batch/mysql (not yet shipped). ` +
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
      ]),
    );
  });
});
