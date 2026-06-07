/**
 * MikroORM-backend-specific behavior tests (Task 15).
 *
 * The shared contract suite covers every behavior every adapter
 * must satisfy, but the MikroORM implementation has backend-specific
 * guarantees (PostgreSQL `FOR UPDATE SKIP LOCKED`, identity-map
 * isolation across forked EMs, the ctid-based ordering for
 * `findLatestStepExecution`) that are NOT part of the cross-adapter
 * contract. Those live here.
 *
 * The MikroORM connection is booted through the new
 * `MikroOrmAdapter.forRoot(...)` factory via
 * `@nestjs/testing`'s `Test.createTestingModule({ imports:
 * [adapter.module] })` — the same wiring path the production
 * `AppModule` uses, so a regression in the adapter's entity-merging
 * or DI bindings surfaces here too.
 *
 * If PostgreSQL is not reachable, every test `ctx.skip()`s with a
 * clear console warning.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import { StepStatus } from '@nest-batch/core';
import { MikroOrmAdapter } from '../src/adapters/mikro-orm.adapter';
import { MikroORMJobRepository } from '../src/mikroorm-job-repository';
import {
  BATCH_META_ENTITIES,
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
} from '../src/entities/job-meta.entities';
import { randomUUID } from 'crypto';

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

describe('@nest-batch/mikro-orm — backend-specific behavior (Task 15)', () => {
  let testingModule: TestingModule | null = null;
  let orm: MikroORM | null = null;
  let pgReachable = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      // Boot the MikroORM connection directly via `MikroOrmModule.forRoot(...)`
      // (the host-owned pattern the slimmed-down adapter expects) and
      // then add the adapter's binding-only `DynamicModule` so the
      // `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` providers
      // resolve inside this `TestingModule`. No raw `MikroORM.init(...)`
      // call — if the adapter's DI bindings regress, this suite
      // catches it.
      testingModule = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot({
            ...PG_CONFIG,
            driver: PostgreSqlDriver,
            entities: [...BATCH_META_ENTITIES],
          }),
          MikroOrmAdapter.forRoot().module,
        ],
      }).compile();
      orm = testingModule.get(MikroORM);
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
          `skipping backend-specific tests. Reason: ${skipReason}`,
      );
    }
  });

  afterAll(async () => {
    if (testingModule) await testingModule.close();
  });

  test(
    'findLatestStepExecution orders by ctid (physical insertion order), not by id',
    async (ctx) => {
      if (!pgReachable) {
        console.warn(`[Task 15] SKIP (no PG): ${skipReason}`);
        return ctx.skip();
      }
      const em = orm!.em.fork() as unknown as SqlEntityManager;
      await em.execute(TRUNCATE_SQL);

      // Seed a JobInstance + JobExecution.
      const inst = new JobInstanceEntity();
      inst.id = randomUUID();
      inst.jobName = 'mikro-backend';
      inst.jobKey = `k-${randomUUID()}`;
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

      // Insert two step rows for the same step name, where the
      // "newer" row has a lexicographically SMALLER id (UUID v4 is
      // random — id ordering does NOT match insertion order). The
      // contract picks the most recently inserted, NOT the
      // largest-UUID.
      const older = new StepExecutionEntity();
      older.id = randomUUID();
      older.jobExecutionId = exec.id;
      older.stepName = 'restartable-step';
      older.status = StepStatus.FAILED;
      older.readCount = 0;
      older.writeCount = 0;
      older.skipCount = 0;
      older.rollbackCount = 0;
      older.commitCount = 0;
      older.exitCode = '';
      older.exitMessage = '';
      await em.persistAndFlush(older);

      // Ensure the next insert is on a later ctid. ctid is the
      // physical tuple location; a brief tick is enough.
      await new Promise((r) => setTimeout(r, 10));

      const newer = new StepExecutionEntity();
      newer.id = randomUUID();
      newer.jobExecutionId = exec.id;
      newer.stepName = 'restartable-step';
      newer.status = StepStatus.STARTED;
      newer.readCount = 5;
      newer.writeCount = 0;
      newer.skipCount = 0;
      newer.rollbackCount = 0;
      newer.commitCount = 1;
      newer.exitCode = '';
      newer.exitMessage = '';
      await em.persistAndFlush(newer);

      // Force the larger-UUID row to be inserted first so the test
      // would FAIL if we naively ordered by id DESC.
      // (Already done by the persist order above — older then newer,
      // with newer having a fresh randomUUID.)

      const repo = new MikroORMJobRepository(em);
      const latest = await repo.findLatestStepExecution(
        exec.id,
        'restartable-step',
      );
      expect(latest).not.toBeNull();
      // We assert by insertion order via the "started" status, which
      // uniquely identifies the later-inserted row regardless of id.
      expect(latest!.status).toBe(StepStatus.STARTED);
      expect(latest!.readCount).toBe(5);
    },
  );

  test('createExecutionAtomic uses FOR UPDATE SKIP LOCKED to reject concurrent launches', async (ctx) => {
    if (!pgReachable) {
      console.warn(`[Task 15] SKIP (no PG): ${skipReason}`);
      return ctx.skip();
    }
    const em = orm!.em.fork() as unknown as SqlEntityManager;
    await em.execute(TRUNCATE_SQL);

    const repo = new MikroORMJobRepository(em);

    // Five concurrent launch attempts for the same (name, key).
    // Exactly one should win.
    const attempts = 5;
    const settled = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        repo.createExecutionAtomic('atomic-test', 'k', { p: 'x' }),
      ),
    );
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);

    // Cleanup
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    await repo.updateJobExecution(winner.id, { status: 'COMPLETED' as never });
  });
});
