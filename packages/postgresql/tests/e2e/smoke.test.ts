// Smoke placeholder for the @nest-batch/postgresql e2e suite.
//
// Why this file exists: vitest 2.x defaults passWithNoTests to false,
// so an empty tests/e2e directory makes 'pnpm test:e2e' exit 1
// ("No test files found"). vitest.e2e.config.ts now sets
// passWithNoTests: true, but a passing it() proves the runner, swc
// plugin, resolve.alias chain, and config wiring all work end-to-end
// (not just "did not error").
//
// This placeholder is intentionally trivial (1 + 1 = 2). Task #13
// replaces it with the real 4-shell e2e suite (MikroOrmPostgres,
// TypeOrmPostgres, DrizzlePostgres, PrismaPostgres) running against
// a Postgres testcontainer. When Task #13 lands, delete this file
// and the passWithNoTests: true flag in vitest.e2e.config.ts so a
// missing suite fails the build again.
import { describe, it, expect } from 'vitest';

describe('@nest-batch/postgresql e2e', () => {
  it('smoke', () => {
    expect(1 + 1).toBe(2);
  });
});
