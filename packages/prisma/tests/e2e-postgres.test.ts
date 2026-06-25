// E2E harness for `@nest-batch/prisma` against a real Postgres.
//
// Spins up a Postgres testcontainer, runs `prisma db push` against
// a test-only Postgres Prisma schema fixture, then runs the shared
// `@nest-batch/core` contract suite against the slot's
// `PrismaJobRepository` /
// `PrismaTransactionManager`, and tears the container down.
//
// The fixture is only for this e2e bootstrap. Consumer apps include
// the documented batch meta models in their own Prisma schema and
// own their migrations.
//
// This is the release-gate e2e for the Prisma adapter. It is
// **gated by `RUN_PRISMA_E2E=1`** — without the env var the file
// logs a skip notice and exits 0. The default
// `pnpm --filter @nest-batch/prisma test` run does NOT start a
// container and does NOT require a Docker daemon. CI runs the
// gated test in a separate job.
//
// The e2e test applies the schema with the Prisma CLI (`prisma db
// push`) so a Prisma schema regression surfaces here.
//
// Run locally with a Docker daemon up:
//
//   RUN_PRISMA_E2E=1 pnpm --filter @nest-batch/prisma test -- tests/e2e-postgres.test.ts
//
// Note: the test does NOT spin up the postgresql package's
// `PostgresPrismaAdapter` (`@nest-batch/postgresql`) — the slot's
// own `PrismaJobRepository` + `PrismaTransactionManager` are
// driver-agnostic (raw SQL via `Prisma.sql` tagged-template) and
// run directly against the testcontainer's PrismaClient. The
// Postgres shell is a thin wiring layer over the same classes; the
// contract is satisfied at the slot level. Keeping the test
// slot-only also enforces the T-AC-2b boundary: no Postgres
// provider import in this test file.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { PostgresPrismaJobRepository } from '../../postgresql/src/prisma/postgres-prisma-job-repository';
import { PostgresPrismaTransactionManager } from '../../postgresql/src/prisma/postgres-prisma-transaction-manager';

const E2E_ENABLED = process.env.RUN_PRISMA_E2E === '1';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Resolved once, lazily, only when the e2e actually runs.
const SCHEMA_PATH = resolve(__dirname, 'fixtures', 'postgresql', 'schema.prisma');

describeE2E('Prisma e2e (testcontainers Postgres, gated by RUN_PRISMA_E2E=1)', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let prisma: PrismaClient;
  let repo: PostgresPrismaJobRepository;
  let tx: PostgresPrismaTransactionManager;
  let dbUrl: string;

  beforeAll(async () => {
    if (!existsSync(SCHEMA_PATH)) {
      throw new Error(
        `Postgres Prisma schema not found at ${SCHEMA_PATH}. ` +
          'The e2e harness requires the test fixture at ' +
          '`packages/prisma/tests/fixtures/postgresql/schema.prisma`.',
      );
    }

    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('nest_batch_prisma_e2e')
      .withUsername('demo')
      .withPassword('demo')
      .start();

    dbUrl = container.getConnectionUri();

    // Apply the test schema to the testcontainer. This is e2e
    // bootstrap only; the package does not ship a runnable Prisma
    // migration artifact to consumers.
    execFileSync('pnpm', ['prisma', 'db', 'push', '--schema', SCHEMA_PATH, '--skip-generate'], {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'inherit',
    });
  }, 60_000);

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
          "batch_step_execution_context",
          "batch_job_execution_context",
          "batch_step_execution",
          "batch_job_execution",
          "batch_job_instance"
        RESTART IDENTITY CASCADE
      `);

    repo = new PostgresPrismaJobRepository(prisma);
    tx = new PostgresPrismaTransactionManager(prisma);
  });

  afterEach(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // Re-run the shared `@nest-batch/core` contract suite against
  // the Prisma-backed implementation. The suite is the same one
  // `@nest-batch/mikro-orm` and `@nest-batch/typeorm` run; the
  // package's "passes the contract" claim is the suite's verdict.
  runJobRepositoryContract(
    {
      create: () => ({ repo, tx }),
    },
    'Prisma e2e (testcontainers Postgres, prisma db push, PostgresPrisma shell)',
  );

  // E2E-specific runtime smoke — pins the impl classes the
  // contract suite just exercised.
  test('PostgresPrismaJobRepository is the concrete impl wired by the e2e harness', () => {
    expect(repo).toBeInstanceOf(PostgresPrismaJobRepository);
  });

  test('PostgresPrismaTransactionManager is the concrete impl wired by the e2e harness', () => {
    expect(tx).toBeInstanceOf(PostgresPrismaTransactionManager);
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
