/**
 * Task 6 (Wave 1) — Failing MikroORM restart and checkpoint tests.
 *
 * TDD-RED: these tests prove the production
 * `MikroORMJobRepository.findLatestStepExecution` must return the
 * latest matching `StepExecution` row for restart/checkpoint resume.
 *
 * Today the method is a stub
 * (apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts:223-230)
 * that returns `null` unconditionally, so the test cases that
 * expect a real row will FAIL — that is the RED state. The "no
 * matching step" case is a contract guardrail: the stub also
 * returns `null` here, so it passes both before and after the
 * GREEN fix lands in Task 10. The GREEN implementation MUST keep
 * the null-on-miss contract.
 *
 * Each test inserts rows directly via `EntityManager` so it does
 * not depend on the production job launcher. The PostgreSQL test
 * DB lives on `localhost:5434` (db=nest_batch_demo, user/pass=
 * demo) per the demo e2e setup; see
 * `apps/demo/tests/e2e/import-products.e2e.spec.ts` for the same
 * connection pattern.
 *
 * If PostgreSQL is not reachable on this machine, every test
 * `ctx.skip()`s with a clear console warning. The RED expectation
 * is still captured in `.omo/evidence/task-6-mikro-restart-*.txt`.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MikroORM, type EntityManager, type Options } from '@mikro-orm/core';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';

import { StepStatus } from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  JobInstanceEntity,
  JobExecutionEntity,
  JobExecutionParamsEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
  MikroORMJobRepository,
} from '@nest-batch/mikro-orm';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
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
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Insert a JobInstance + JobExecution pair and return both ids.
 * The StepExecution rows reference the JobExecution id, so each
 * test needs at least one execution row in place to exercise the
 * checkpoint lookup.
 */
async function seedJobExecution(
  em: EntityManager,
  jobName: string,
  jobKey: string,
): Promise<{ jobInstanceId: string; jobExecutionId: string }> {
  const inst = new JobInstanceEntity();
  inst.id = randomUUID();
  inst.jobName = jobName;
  inst.jobKey = jobKey;
  inst.createdAt = new Date();
  await em.persistAndFlush(inst);

  const exec = new JobExecutionEntity();
  exec.id = randomUUID();
  exec.jobInstanceId = inst.id;
  exec.status = 'STARTED';
  exec.startTime = new Date();
  exec.endTime = null;
  exec.exitCode = '';
  exec.exitMessage = '';
  await em.persistAndFlush(exec);

  return { jobInstanceId: inst.id, jobExecutionId: exec.id };
}

/**
 * Insert one StepExecution row with the given (jobExecutionId,
 * stepName) and return its primary key. The test asserts the
 * returned id later, so the row must be persisted before the call
 * to `findLatestStepExecution`.
 */
async function seedStepExecution(
  em: EntityManager,
  jobExecutionId: string,
  stepName: string,
  status: StepStatus = StepStatus.COMPLETED,
  readCount = 0,
): Promise<string> {
  const step = new StepExecutionEntity();
  step.id = randomUUID();
  step.jobExecutionId = jobExecutionId;
  step.stepName = stepName;
  step.status = status;
  step.readCount = readCount;
  step.writeCount = 0;
  step.skipCount = 0;
  step.rollbackCount = 0;
  step.commitCount = 0;
  step.exitCode = '';
  step.exitMessage = '';
  await em.persistAndFlush(step);
  return step.id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MikroORMJobRepository.findLatestStepExecution (Task 6 — RED)', () => {
  let orm: MikroORM | null = null;
  let em: EntityManager;
  let pgReachable = false;
  let skipReason = '';

  beforeAll(async () => {
    const ormConfig: Options = {
      driver: PostgreSqlDriver,
      ...PG_CONFIG,
      entities: [...BATCH_META_ENTITIES],
    };
    try {
      orm = await MikroORM.init(ormConfig);
      pgReachable = true;
    } catch (err) {
      // Some drivers throw a Node AggregateError whose `.message` is
      // empty — surface the cause chain so the skip reason is
      // actionable.
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
        `[Task 6 RED] PostgreSQL test DB unreachable on ` +
          `${PG_CONFIG.host}:${PG_CONFIG.port} (db=${PG_CONFIG.dbName}) — ` +
          `skipping live DB tests. Reason: ${skipReason}`,
      );
    }
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  // -------------------------------------------------------------------------
  // RED 1: latest matching step wins
  // -------------------------------------------------------------------------
  test(
    'RED: returns the latest StepExecution row for the given (jobExecutionId, stepName) when multiple exist',
    async (ctx) => {
      if (!pgReachable) {
        console.warn(`[Task 6 RED] SKIP (no PG): ${skipReason}`);
        return ctx.skip();
      }
      em = orm!.em.fork() as unknown as SqlEntityManager;
      await em.execute(TRUNCATE_SQL);

      const repo = new MikroORMJobRepository(em);
      const { jobExecutionId } = await seedJobExecution(
        em,
        'checkpoint-test',
        `k-latest-${randomUUID()}`,
      );

      // Two rows, same (jobExecutionId, stepName), different
      // insertion order. Production must return the second one
      // (the "latest"). The stub returns null which is wrong
      // → RED.
      const olderId = await seedStepExecution(
        em,
        jobExecutionId,
        'import-products',
        StepStatus.FAILED,
        10,
      );
      const newerId = await seedStepExecution(
        em,
        jobExecutionId,
        'import-products',
        StepStatus.COMPLETED,
        20,
      );

      const latest = await repo.findLatestStepExecution(
        jobExecutionId,
        'import-products',
      );

      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(newerId);
      expect(latest!.id).not.toBe(olderId);
      expect(latest!.status).toBe(StepStatus.COMPLETED);
      expect(latest!.readCount).toBe(20);
    },
  );

  // -------------------------------------------------------------------------
  // Negative contract: no matching step → null
  // -------------------------------------------------------------------------
  test(
    'Negative contract: returns null when no StepExecution exists for the given (jobExecutionId, stepName)',
    async (ctx) => {
      if (!pgReachable) {
        console.warn(`[Task 6 RED] SKIP (no PG): ${skipReason}`);
        return ctx.skip();
      }
      em = orm!.em.fork() as unknown as SqlEntityManager;
      await em.execute(TRUNCATE_SQL);

      const repo = new MikroORMJobRepository(em);
      const { jobExecutionId } = await seedJobExecution(
        em,
        'checkpoint-test',
        `k-nil-${randomUUID()}`,
      );

      // Insert a step with a DIFFERENT step name so the lookup for
      // 'import-products' finds nothing. The stub returns null
      // which happens to match the contract here — this case is a
      // guard against the GREEN implementation accidentally
      // returning a foreign row.
      await seedStepExecution(em, jobExecutionId, 'validate-csv');

      const result = await repo.findLatestStepExecution(
        jobExecutionId,
        'import-products',
      );

      expect(result).toBeNull();
    },
  );

  // -------------------------------------------------------------------------
  // RED 2: previous failed execution is ignored
  // -------------------------------------------------------------------------
  test(
    "RED: only considers steps from the given jobExecutionId — a prior failed execution's step row is NOT picked up",
    async (ctx) => {
      if (!pgReachable) {
        console.warn(`[Task 6 RED] SKIP (no PG): ${skipReason}`);
        return ctx.skip();
      }
      em = orm!.em.fork() as unknown as SqlEntityManager;
      await em.execute(TRUNCATE_SQL);

      const repo = new MikroORMJobRepository(em);
      const { jobExecutionId: currentExecId } = await seedJobExecution(
        em,
        'checkpoint-test',
        `k-current-${randomUUID()}`,
      );
      const { jobExecutionId: priorExecId } = await seedJobExecution(
        em,
        'checkpoint-test',
        `k-prior-${randomUUID()}`,
      );

      // The "prior" execution had a FAILED 'import-products' step —
      // the canonical restart scenario.
      const priorFailedStepId = await seedStepExecution(
        em,
        priorExecId,
        'import-products',
        StepStatus.FAILED,
        99,
      );
      // The "current" execution has a partial 'import-products'
      // step (a fresh restart).
      const currentStepId = await seedStepExecution(
        em,
        currentExecId,
        'import-products',
        StepStatus.STARTED,
        5,
      );

      const latest = await repo.findLatestStepExecution(
        currentExecId,
        'import-products',
      );

      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(currentStepId);
      expect(latest!.id).not.toBe(priorFailedStepId);
      expect(latest!.jobExecutionId).toBe(currentExecId);
    },
  );
});
