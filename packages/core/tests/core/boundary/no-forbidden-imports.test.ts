import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/nest-batch/tests/core/boundary -> packages/nest-batch/src
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');

/**
 * Packages that must NEVER be imported from @nest-batch/core source.
 *
 * Adding any of these to `src/**` would drag heavy integrations (queue runtimes,
 * ORMs, cron engines) into the dependency-light core package. They belong in
 * sibling packages that core does not know about.
 *
 * Each entry matches:
 *  - the bare package name (e.g. "bullmq")
 *  - any subpath under that name (e.g. "bullmq/flows")
 *  - scoped variants explicitly listed (e.g. "@mikro-orm/...")
 */
const FORBIDDEN_PACKAGES: readonly string[] = [
  'bullmq',
  'mikro-orm',
  '@mikro-orm',
  'typeorm',
  'drizzle-orm',
  'drizzle',
  'cron',
];

/**
 * Extract every import / require specifier (string literal) from a TS source
 * file. Captures:
 *  - `import x from 'pkg'`
 *  - `import { y } from 'pkg'`
 *  - `import * as z from 'pkg'`
 *  - `import 'pkg'`                (side-effect)
 *  - `await import('pkg')`         (dynamic)
 *  - `require('pkg')`
 */
const IMPORT_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function isForbiddenSpecifier(specifier: string): string | null {
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg) return pkg;
    if (specifier.startsWith(`${pkg}/`)) return pkg;
  }
  return null;
}

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

interface Violation {
  file: string;
  specifier: string;
  matchedPackage: string;
}

describe('dependency boundary: @nest-batch/core must not import forbidden packages', () => {
  const violations: Violation[] = [];
  const scannedFiles: string[] = [];

  for (const file of walkTypeScriptFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file);
    scannedFiles.push(rel);
    const text = readFileSync(file, 'utf8');
    IMPORT_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPEC_RE.exec(text)) !== null) {
      const spec = match[1]!;
      const matched = isForbiddenSpecifier(spec);
      if (matched !== null) {
        violations.push({ file: rel, specifier: spec, matchedPackage: matched });
      }
    }
  }

  it('scans at least one source file (sanity check on the test harness)', () => {
    expect(scannedFiles.length).toBeGreaterThan(0);
  });

  it('contains no imports of bullmq, mikro-orm, typeorm, drizzle, or cron', () => {
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}: imports "${v.specifier}" (matched: ${v.matchedPackage})`)
        .join('\n');
      throw new Error(
        `Forbidden imports detected in @nest-batch/core src/:\n${detail}\n\n` +
          `These packages must live in sibling integration packages, not in core.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('the forbidden package list explicitly covers bullmq, mikro-orm, typeorm, drizzle, and cron', () => {
    // Guardrail so a future edit cannot silently drop a package from the
    // watchlist.
    expect(FORBIDDEN_PACKAGES).toEqual(
      expect.arrayContaining(['bullmq', 'mikro-orm', 'typeorm', 'drizzle-orm', 'drizzle', 'cron']),
    );
  });
});
