// E2E harness for `@nest-batch/drizzle` against a real Postgres.
//
// Spins up a Postgres testcontainer, applies the batch meta-schema
// (the 6-table DDL shipped in
// `@nest-batch/postgresql/migrations/0001-create-batch-meta.sql`),
// runs the shared `@nest-batch/core` contract suite against the
// slot's `DrizzleJobRepository` / `DrizzleTransactionManager`, and
// tears the container down.
//
// The Drizzle slot is **driver-agnostic** in 0.2.0 — the
// Postgres-flavored `pgTable` schema and the
// `PostgresDrizzleJobRepository` / `PostgresDrizzleTransactionManager`
// (typed `NodePgDatabase<typeof schema>`) live in
// `@nest-batch/postgresql/src/drizzle/`. The slot's
// `DrizzleJobRepository` / `DrizzleTransactionManager` use raw SQL
// via the `sql` template tag from `drizzle-orm` (the schema-only
// peer) and accept any db handle with `.execute()` and
// `.transaction()` methods — they do NOT need the
// `drizzle-orm/pg-core` schema. This test passes a real
// `NodePgDatabase` (built via `drizzle-orm/node-postgres`) to
// confirm the slot's contract holds end-to-end against a live
// Postgres, which is what the slot's "passes the contract" claim
// means in 0.2.0.
//
// The Postgres shell (`@nest-batch/postgresql/src/drizzle/`) is
// exercised by the `@nest-batch/postgresql` package's own e2e
// suite (Task #13) — it is a different impl class
// (`PostgresDrizzleJobRepository`) that uses the typed schema API.
// Keeping this test slot-only also enforces the T-AC-2b boundary:
// no Postgres provider import in the slot's source tree (this
// file is in `tests/`, which the boundary test does NOT scan).
//
// This is the release-gate e2e for the Drizzle adapter. It is
// **gated by `RUN_DRIZZLE_E2E=1`** — without the env var the
// file logs a skip notice and exits 0. The default
// `pnpm --filter @nest-batch/drizzle test` run does NOT start a
// container and does NOT require a Docker daemon. CI runs the
// gated test in a separate job.
//
// Run locally with a Docker daemon up:
//
//   RUN_DRIZZLE_E2E=1 pnpm --filter @nest-batch/drizzle test -- tests/e2e-postgres.test.ts

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../../postgresql/src/drizzle-schema.postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { DrizzleJobRepository } from '../src/repository/drizzle-job-repository';
import { DrizzleTransactionManager } from '../src/transaction/drizzle-transaction-manager';

const E2E_ENABLED = process.env.RUN_DRIZZLE_E2E === '1';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Resolved once, lazily, only when the e2e actually runs. The
// DDL lives in `@nest-batch/postgresql` (the F4 refactor moved
// the 6-table migration out of `@nest-batch/drizzle/src/schema.ts`)
// — the test reads it from the filesystem to avoid a
// `@nest-batch/drizzle` → `@nest-batch/postgresql` devDep cycle
// (the postgresql package already depends on drizzle for its
// shell, so the cycle is unavoidable the other direction).
const MIGRATION_PATH = resolve(
  __dirname,
  '..',
  '..',
  'postgresql',
  'migrations',
  '0001-create-batch-meta.sql',
);

describeE2E(
  'Drizzle e2e (testcontainers Postgres, gated by RUN_DRIZZLE_E2E=1)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: Pool;
    let db: NodePgDatabase<typeof pgSchema>;
    let repo: DrizzleJobRepository;
    let tx: DrizzleTransactionManager;

    beforeAll(async () => {
      if (!existsSync(MIGRATION_PATH)) {
        throw new Error(
          `Postgres migration not found at ${MIGRATION_PATH}. ` +
            'The e2e harness requires the 6-table batch meta ' +
            'migration at ' +
            '`packages/postgresql/migrations/0001-create-batch-meta.sql` ' +
            '(the canonical location post-F4 refactor).',
        );
      }
      const ddl = readFileSync(MIGRATION_PATH, 'utf8');

      container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('nest_batch_drizzle_e2e')
        .withUsername('demo')
        .withPassword('demo')
        .start();

      pool = new Pool({ connectionString: container.getConnectionUri() });

      // The migration file lists CREATE INDEX statements
      // interleaved with their target CREATE TABLE statements
      // (the index for `batch_job_execution` precedes the
      // `CREATE TABLE batch_job_execution` block, same for
      // `batch_step_execution`). Postgres rejects the index
      // creation if the target table does not exist yet, so we
      // split the file into individual statements, run all
      // CREATE TABLE statements first, then the CREATE INDEX
      // statements. The order within each group is irrelevant
      // (the tables have no cross-table FK dependencies that
      // would force a specific order, and IF NOT EXISTS makes
      // the splits idempotent).
      const rawStatements = ddl
        .split(/;\s*(?=\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const tableStatements = rawStatements.filter((s) =>
        /CREATE\s+TABLE\b/i.test(s),
      );
      const indexStatements = rawStatements.filter(
        (s) => /CREATE\s+INDEX\b/i.test(s),
      );
      const ordered = [...tableStatements, ...indexStatements];

      const client = await pool.connect();
      try {
        for (const stmt of ordered) {
          await client.query(stmt);
        }
      } finally {
        client.release();
      }
    }, 120_000);

    afterAll(async () => {
      if (pool) await pool.end();
      if (container) await container.stop();
    });

    beforeEach(async () => {
      await pool.query(`
        TRUNCATE TABLE
          batch_step_execution_context,
          batch_job_execution_context,
          batch_step_execution,
          batch_job_execution,
          batch_job_instance
        RESTART IDENTITY CASCADE
      `);

      db = drizzle(pool, { schema: pgSchema });
      // The slot's DrizzleJobRepository / DrizzleTransactionManager
      // take the db via the DrizzleDriverProvider DI token; the
      // contract suite needs the concrete instances with the same
      // db, so we construct them directly. `any` is safe — the
      // slot's raw-SQL path is driver-agnostic.
      repo = new DrizzleJobRepository(db as unknown as any);
      tx = new DrizzleTransactionManager(db as unknown as any);
    });

    // Re-run the shared `@nest-batch/core` contract suite against
    // the slot's Drizzle-backed implementation. The suite is the
    // same one `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, and
    // `@nest-batch/prisma` run; the package's "passes the contract"
    // claim is the suite's verdict.
    runJobRepositoryContract(
      {
        create: () => ({ repo, tx }),
      },
      'Drizzle e2e (testcontainers Postgres)',
    );

    test('DrizzleJobRepository is the concrete impl wired by the e2e harness', () => {
      expect(repo).toBeInstanceOf(DrizzleJobRepository);
    });

    test('DrizzleTransactionManager is the concrete impl wired by the e2e harness', () => {
      expect(tx).toBeInstanceOf(DrizzleTransactionManager);
    });
  },
);

/**
 * Skip notice — printed when `RUN_DRIZZLE_E2E=1` is NOT set so a CI
 * log makes the gate's reason obvious. Uses `test` (not `describe`)
 * so the notice does not pollute the contract suite's `describe`
 * tree when the gate is open.
 */
describe('Drizzle e2e (skipped — RUN_DRIZZLE_E2E=1 not set)', () => {
  test('skip notice', () => {
    if (E2E_ENABLED) {
      expect(E2E_ENABLED).toBe(true);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        '  [drizzle e2e] skipped — set RUN_DRIZZLE_E2E=1 to run the ' +
        'testcontainers Postgres harness.\n' +
        '  [drizzle e2e] command: RUN_DRIZZLE_E2E=1 pnpm --filter ' +
        '@nest-batch/drizzle test -- tests/e2e-postgres.test.ts\n',
    );
    expect(E2E_ENABLED).toBe(false);
  });
});
