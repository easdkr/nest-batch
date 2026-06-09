/**
 * E2E harness for `@nest-batch/drizzle` against a real Postgres.
 *
 * Spins up a Postgres testcontainer, applies the batch meta-schema,
 * runs the shared `@nest-batch/core` contract suite against the
 * Drizzle-backed `DrizzleJobRepository` / `DrizzleTransactionManager`,
 * and tears the container down.
 *
 * This is the release-gate e2e for the Drizzle adapter. It is
 * **gated by `RUN_DRIZZLE_E2E=1`** — without the env var the file
 * logs a skip notice and exits 0. The default
 * `pnpm --filter @nest-batch/drizzle test` run does NOT start a
 * container and does NOT require a Docker daemon. CI runs the
 * gated test in a separate job.
 *
 * Run locally with a Docker daemon up:
 *
 *   RUN_DRIZZLE_E2E=1 pnpm --filter @nest-batch/drizzle test -- tests/e2e-postgres.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import * as schema from '../src/schema';
import { DrizzleJobRepository } from '../src/repository/drizzle-job-repository';
import { DrizzleTransactionManager } from '../src/transaction/drizzle-transaction-manager';

const E2E_ENABLED = process.env.RUN_DRIZZLE_E2E === '1';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('Drizzle e2e (testcontainers Postgres, gated by RUN_DRIZZLE_E2E=1)', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let repo: DrizzleJobRepository;
  let tx: DrizzleTransactionManager;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('nest_batch_drizzle_e2e')
      .withUsername('demo')
      .withPassword('demo')
      .start();

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Apply the batch meta-schema (the same 5 tables the Drizzle
    // `pgTable` definitions describe). The 6th table
    // (`batch_job_execution_params`) is intentionally absent — see
    // README §"Schema ownership".
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS batch_job_instance (
          id           VARCHAR(255) PRIMARY KEY,
          job_name     VARCHAR(255) NOT NULL,
          job_key      VARCHAR(255) NOT NULL,
          created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          UNIQUE (job_name, job_key)
        );

        CREATE TABLE IF NOT EXISTS batch_job_execution (
          id               VARCHAR(255) PRIMARY KEY,
          job_instance_id  VARCHAR(255) NOT NULL REFERENCES batch_job_instance(id) ON DELETE CASCADE,
          status           VARCHAR(20)  NOT NULL,
          start_time       TIMESTAMPTZ,
          end_time         TIMESTAMPTZ,
          exit_code        VARCHAR(255) NOT NULL DEFAULT '',
          exit_message     TEXT         NOT NULL DEFAULT '',
          params           TEXT         NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_batch_job_execution_job_instance_id
          ON batch_job_execution(job_instance_id);

        CREATE TABLE IF NOT EXISTS batch_step_execution (
          id               VARCHAR(255) PRIMARY KEY,
          job_execution_id VARCHAR(255) NOT NULL REFERENCES batch_job_execution(id) ON DELETE CASCADE,
          step_name        VARCHAR(255) NOT NULL,
          status           VARCHAR(20)  NOT NULL,
          read_count       INT          NOT NULL DEFAULT 0,
          write_count      INT          NOT NULL DEFAULT 0,
          skip_count       INT          NOT NULL DEFAULT 0,
          rollback_count   INT          NOT NULL DEFAULT 0,
          commit_count     INT          NOT NULL DEFAULT 0,
          exit_code        VARCHAR(255) NOT NULL DEFAULT '',
          exit_message     TEXT         NOT NULL DEFAULT '',
          created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_batch_step_execution_job_execution_id
          ON batch_step_execution(job_execution_id);

        CREATE TABLE IF NOT EXISTS batch_job_execution_context (
          job_execution_id VARCHAR(255) PRIMARY KEY,
          data             TEXT         NOT NULL,
          version          INT          NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS batch_step_execution_context (
          step_execution_id VARCHAR(255) PRIMARY KEY,
          data              TEXT         NOT NULL,
          version           INT          NOT NULL DEFAULT 0
        );
      `);
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    // Truncate in FK-respecting order so each test starts clean.
    await pool.query(`
      TRUNCATE TABLE
        batch_step_execution_context,
        batch_job_execution_context,
        batch_step_execution,
        batch_job_execution,
        batch_job_instance
      RESTART IDENTITY CASCADE
    `);

    db = drizzle(pool, { schema });
    repo = new DrizzleJobRepository(db);
    tx = new DrizzleTransactionManager(db);
  });

  // Re-run the shared `@nest-batch/core` contract suite against the
  // Drizzle-backed implementation. The suite is the same one
  // `@nest-batch/mikro-orm` and `@nest-batch/typeorm` run; the
  // package's "passes the contract" claim is the suite's verdict.
  runJobRepositoryContract(
    {
      create: () => ({ repo, tx }),
    },
    'Drizzle e2e (testcontainers Postgres)',
  );

  // E2E-specific runtime smoke — pins the impl classes the contract
  // suite just exercised.
  test('DrizzleJobRepository is the concrete impl wired by the e2e harness', () => {
    expect(repo).toBeInstanceOf(DrizzleJobRepository);
  });

  test('DrizzleTransactionManager is the concrete impl wired by the e2e harness', () => {
    expect(tx).toBeInstanceOf(DrizzleTransactionManager);
  });
});

/**
 * Skip notice — printed when `RUN_DRIZZLE_E2E=1` is NOT set so a CI
 * log makes the gate's reason obvious. Uses `test` (not `describe`)
 * so the notice does not pollute the contract suite's `describe`
 * tree when the gate is open.
 */
describe('Drizzle e2e (skipped — RUN_DRIZZLE_E2E=1 not set)', () => {
  test('skip notice', () => {
    if (E2E_ENABLED) {
      // The e2e block above is running; the notice is a no-op.
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
