/**
 * TDD-GREEN: the shared `@nest-batch/core` repository/transaction
 * contract suite running against the MikroORM implementation.
 *
 * The contract suite (`runJobRepositoryContract`) is the single
 * source of truth for the `JobRepository` + `TransactionManager`
 * behavior every `@nest-batch/*` adapter must satisfy. We import it
 * directly from the core package's source — no other adapter
 * (TypeORM, in-memory, etc.) owns a copy; the same suite runs
 * against every backend.
 *
 * Per-test isolation is provided by:
 *   - a fresh `EntityManager` (`orm.em.fork()`) so identity-map
 *     state from prior tests cannot leak into a later test, and
 *   - a `TRUNCATE TABLE ... CASCADE` of every batch_* table.
 *
 * If PostgreSQL is not reachable, every test `ctx.skip()`s with a
 * clear console warning. The contract still runs in CI where PG is
 * available, and locally when developers have the demo docker
 * compose stack up.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MikroORM, type Options } from '@mikro-orm/core';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import { runJobRepositoryContract } from '@nest-batch/core/test-contracts';
import { MikroORMJobRepository } from '../src/mikroorm-job-repository';
import { MikroORMTransactionManager } from '../src/mikroorm-transaction-manager';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  JobExecutionParamsEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from '../src/entities/job-meta.entities';

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_mikro',
};

const TRUNCATE_SQL = `
  TRUNCATE TABLE batch_step_execution_context,
               batch_job_execution_context,
               batch_step_execution,
               batch_job_execution_params,
               batch_job_execution,
               batch_job_instance
  RESTART IDENTITY CASCADE
`;

// ---------------------------------------------------------------------------
// PG-reachability probe: skip the entire contract suite cleanly when
// PostgreSQL is not available, so contributors without the demo
// docker compose stack do not see a wall of red failures.
// ---------------------------------------------------------------------------

describe('@nest-batch/mikro-orm contract — JobRepository + TransactionManager (Task 15)', () => {
  let orm: MikroORM | null = null;
  let pgReachable = false;
  let skipReason = '';

  beforeAll(async () => {
    const ormConfig: Options = {
      driver: PostgreSqlDriver,
      ...PG_CONFIG,
      entities: [
        JobInstanceEntity,
        JobExecutionEntity,
        JobExecutionParamsEntity,
        StepExecutionEntity,
        JobExecutionContextEntity,
        StepExecutionContextEntity,
      ],
    };
    try {
      orm = await MikroORM.init(ormConfig);
      pgReachable = true;
    } catch (err) {
      skipReason =
        err instanceof Error
          ? err.message || err.stack?.split('\n')[0] || err.toString()
          : String(err);
      if (err instanceof AggregateError && err.errors.length > 0) {
        skipReason = err.errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join(' | ');
      }
      console.warn(
        `[Task 15] PostgreSQL test DB unreachable on ` +
          `${PG_CONFIG.host}:${PG_CONFIG.port} (db=${PG_CONFIG.dbName}) — ` +
          `skipping contract suite. Reason: ${skipReason}`,
      );
    }
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  describe('when PostgreSQL is reachable', () => {
    // The contract suite's `beforeEach` calls `factory.create()` per
    // test. We use a closure that captures the live ORM and a fresh
    // forked EM per test for identity-map isolation.
    beforeEach(async (ctx) => {
      if (!pgReachable) {
        console.warn(`[Task 15] SKIP (no PG): ${skipReason}`);
        return ctx.skip();
      }
      const em = orm!.em.fork() as unknown as SqlEntityManager;
      await em.execute(TRUNCATE_SQL);
    });

    runJobRepositoryContract(
      {
        create: () => {
          // The forked EM is bound to the PostgreSqlDriver, so the
          // runtime value IS a SqlEntityManager — we cast at the
          // boundary to keep the package's public signature clean.
          const em = orm!.em.fork() as unknown as SqlEntityManager;
          return {
            repo: new MikroORMJobRepository(em),
            tx: new MikroORMTransactionManager(em),
          };
        },
      },
      'MikroORMJobRepository + MikroORMTransactionManager',
    );
  });

  describe('when PostgreSQL is unreachable', () => {
    // A single guard test that prints a clear skip when PG is not
    // available, so the CI log surfaces the reason rather than just
    // showing skipped tests with no explanation.
    beforeEach((ctx) => {
      if (pgReachable) return ctx.skip();
    });

    test('skips the contract suite and prints the PG-unreachable reason', () => {
      // No assertion: the skip is the point. We only assert that the
      // skip reason was captured, so a future regression that swallows
      // the error becomes visible.
      expect(skipReason.length).toBeGreaterThan(0);
    });
  });
});
