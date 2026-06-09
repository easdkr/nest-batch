/**
 * E2E harness for `@nest-batch/prisma` against a real Postgres.
 *
 * Spins up a Postgres testcontainer, runs `prisma migrate deploy`
 * against the bundled `prisma/schema.prisma` (Postgres provider),
 * runs the shared `@nest-batch/core` contract suite against the
 * Prisma-backed `PrismaJobRepository` / `PrismaTransactionManager`,
 * and tears the container down.
 *
 * This is the release-gate e2e for the Prisma adapter. It is
 * **gated by `RUN_PRISMA_E2E=1`** — without the env var the file
 * logs a skip notice and exits 0. The default
 * `pnpm --filter @nest-batch/prisma test` run does NOT start a
 * container and does NOT require a Docker daemon. CI runs the
 * gated test in a separate job.
 *
 * The contract test (`tests/contract.test.ts`) applies the schema
 * with raw `pg` SQL; the e2e test applies it with the Prisma CLI
 * (`prisma migrate deploy`) so a Prisma migration regression
 * surfaces here, not just in the raw-SQL contract test.
 *
 * Run locally with a Docker daemon up:
 *
 *   RUN_PRISMA_E2E=1 pnpm --filter @nest-batch/prisma test -- tests/e2e-postgres.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { PrismaClient } from '@prisma/client';
import { PrismaJobRepository } from '../src/repository/prisma-job-repository';
import { PrismaTransactionManager } from '../src/transaction/prisma-transaction-manager';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const E2E_ENABLED = process.env.RUN_PRISMA_E2E === '1';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Resolved once, lazily, only when the e2e actually runs. We point
// the Prisma CLI at the bundled schema so the migration applied
// here matches the one shipped in `@nest-batch/prisma`.
const SCHEMA_PATH = resolve(__dirname, '..', 'prisma', 'schema.prisma');

describeE2E('Prisma e2e (testcontainers Postgres, gated by RUN_PRISMA_E2E=1)', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let prisma: PrismaClient;
  let repo: PrismaJobRepository;
  let tx: PrismaTransactionManager;
  let dbUrl: string;

  beforeAll(async () => {
    if (!existsSync(SCHEMA_PATH)) {
      throw new Error(
        `Bundled Prisma schema not found at ${SCHEMA_PATH}. ` +
          'The e2e harness requires the bundled prisma/schema.prisma ' +
          'to apply migrations against the testcontainer.',
      );
    }

    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('nest_batch_prisma_e2e')
      .withUsername('demo')
      .withPassword('demo')
      .start();

    dbUrl = container.getConnectionUri();

    // Apply the bundled migration. `migrate deploy` is the
    // production path: it applies pending migrations without
    // generating a new one, and it tracks applied migrations in
    // `_prisma_migrations` so a re-run is a no-op.
    execFileSync(
      'pnpm',
      [
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        SCHEMA_PATH,
      ],
      {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: 'inherit',
      },
    );
  }, 180_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  beforeEach(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: dbUrl,
        },
      },
    });

    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        batch_step_execution_context,
        batch_job_execution_context,
        batch_step_execution,
        batch_job_execution,
        batch_job_instance
      RESTART IDENTITY CASCADE
    `);

    repo = new PrismaJobRepository(prisma);
    tx = new PrismaTransactionManager(prisma);
  });

  afterEach(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // Re-run the shared `@nest-batch/core` contract suite against the
  // Prisma-backed implementation. The suite is the same one
  // `@nest-batch/mikro-orm` and `@nest-batch/typeorm` run; the
  // package's "passes the contract" claim is the suite's verdict.
  runJobRepositoryContract(
    {
      create: () => ({ repo, tx }),
    },
    'Prisma e2e (testcontainers Postgres, prisma migrate deploy)',
  );

  // E2E-specific runtime smoke — pins the impl classes the contract
  // suite just exercised.
  test('PrismaJobRepository is the concrete impl wired by the e2e harness', () => {
    expect(repo).toBeInstanceOf(PrismaJobRepository);
  });

  test('PrismaTransactionManager is the concrete impl wired by the e2e harness', () => {
    expect(tx).toBeInstanceOf(PrismaTransactionManager);
  });
});

/**
 * Skip notice — printed when `RUN_PRISMA_E2E=1` is NOT set so a CI
 * log makes the gate's reason obvious. Uses `test` (not `describe`)
 * so the notice does not pollute the contract suite's `describe`
 * tree when the gate is open.
 */
describe('Prisma e2e (skipped — RUN_PRISMA_E2E=1 not set)', () => {
  test('skip notice', () => {
    if (E2E_ENABLED) {
      // The e2e block above is running; the notice is a no-op.
      expect(E2E_ENABLED).toBe(true);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        '  [prisma e2e] skipped — set RUN_PRISMA_E2E=1 to run the ' +
        'testcontainers Postgres harness.\n' +
        '  [prisma e2e] command: RUN_PRISMA_E2E=1 pnpm --filter ' +
        '@nest-batch/prisma test -- tests/e2e-postgres.test.ts\n',
    );
    expect(E2E_ENABLED).toBe(false);
  });
});
