/**
 * Boundary contract test (bullmq side).
 *
 * This test exists in the `@nest-batch/bullmq` package (not in core)
 * to assert, *from the adapter's perspective*, the contract that
 * `packages/core/src/` does not import `bullmq` (or any other queue
 * runtime / ORM / cron engine). The mirror test inside
 * `packages/core/tests/core/boundary/no-forbidden-imports.test.ts`
 * owns the actual scanning logic and is the authoritative
 * enforcement point; this test is a deliberate second witness
 * living in the adapter package so the boundary is checked at
 * both ends of the dependency arrow:
 *
 *     @nest-batch/bullmq  ──▶  @nest-batch/core
 *           │                        ▲
 *           │   (this test)          │   (the core-side test)
 *           └────────────────────────┘
 *
 * If the core package ever pulled in `bullmq`, both tests would
 * fail simultaneously — a much louder signal than either would
 * produce in isolation. The test is also a useful smoke check
 * for `pnpm --filter @nest-batch/bullmq test` runs that may not
 * have a working core build at the time of the run (e.g. a fresh
 * checkout where the core workspace link has not been built yet).
 *
 * The scan reads source files only; declarations, build output,
 * and the boundary test code itself are out of scope.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// packages/bullmq/tests/boundary -> packages/bullmq
const PKG_ROOT = resolve(__dirname, '..', '..');
// Resolve the sibling core package by workspace convention. The
// pnpm workspace pins `packages/*` to the root, so the path is
// stable across worktrees.
const CORE_SRC_ROOT = resolve(PKG_ROOT, '..', 'core', 'src');

/**
 * BullMQ is the package this adapter owns — but it must NEVER
 * appear in `packages/core/src/`. The core boundary test has its
 * own (broader) list of forbidden packages; this test mirrors
 * the BullMQ-specific entry as a focused contract check that
 * travels with the adapter.
 */
const FORBIDDEN_FOR_CORE: readonly string[] = [
  'bullmq',
  // BullMQ re-exports ioredis types; treat the same as BullMQ.
  'ioredis',
];

const IMPORT_SPEC_RE =
  /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function isForbiddenSpecifier(specifier: string): string | null {
  for (const pkg of FORBIDDEN_FOR_CORE) {
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

describe('dependency boundary: @nest-batch/core src/ must not import bullmq', () => {
  const violations: Violation[] = [];
  const scannedFiles: string[] = [];

  for (const file of walkTypeScriptFiles(CORE_SRC_ROOT)) {
    const rel = relative(CORE_SRC_ROOT, file);
    scannedFiles.push(rel);
    const text = readFileSync(file, 'utf8');
    IMPORT_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPEC_RE.exec(text)) !== null) {
      const spec = match[1];
      const matched = isForbiddenSpecifier(spec);
      if (matched !== null) {
        violations.push({ file: rel, specifier: spec, matchedPackage: matched });
      }
    }
  }

  it('scans at least one source file in @nest-batch/core/src (sanity check)', () => {
    expect(scannedFiles.length).toBeGreaterThan(0);
  });

  it('contains no imports of bullmq (or ioredis) in @nest-batch/core/src/', () => {
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}: imports "${v.specifier}" (matched: ${v.matchedPackage})`)
        .join('\n');
      throw new Error(
        `Forbidden imports detected in @nest-batch/core src/:\n${detail}\n\n` +
          `BullMQ must live in @nest-batch/bullmq; pulling it into core would ` +
          `drag the queue runtime into the dependency-light core package.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
