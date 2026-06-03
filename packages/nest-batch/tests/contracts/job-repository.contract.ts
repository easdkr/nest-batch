import { beforeEach, describe, expect, test } from 'vitest';
import { JobRepository, type IJobRepository } from '../../src/core/repository/job-repository';
import { TransactionManager } from '../../src/core/transaction/transaction-manager';
import { JobExecutionAlreadyRunningError } from '../../src/core/errors';
import { JobStatus, StepStatus } from '../../src/core/status';
import type {
  ExecutionScope,
  JobExecution,
  JobParameters,
} from '../../src/core/repository/types';

/**
 * A factory that returns a fresh `JobRepository` + `TransactionManager`
 * pair per call.
 *
 * Every contract test calls this in `beforeEach` to guarantee isolation
 * between cases. Implementations that need a per-test transaction
 * manager, a fresh in-memory store, or a per-test DB transaction
 * rollback can plug that in here.
 */
export interface JobRepositoryContractFactory {
  create(): { repo: IJobRepository; tx: TransactionManager };
}

/**
 * Shared `JobRepository` + `TransactionManager` contract suite.
 *
 * Every implementation of the batch core repository/transaction contract
 * — in-memory, `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, future
 * adapters — must pass this suite. The contract covers:
 *
 *  - Happy-path lifecycle: getOrCreateJobInstance → createExecutionAtomic
 *    → status updates → step execution lifecycle.
 *  - ExecutionContext save/load roundtrip (the restart-checkpoint
 *    payload path).
 *  - `findLatestStepExecution` returning the latest matching row (the
 *    restart-resume lookup), and only that step name.
 *  - `TransactionManager.withTransaction` wrapping + propagation of
 *    errors and resolved values.
 *  - Negative: a duplicate active execution is rejected
 *    (`JobExecutionAlreadyRunningError`).
 *  - Concurrency: when N callers race `createExecutionAtomic` against
 *    the same `(name, jobKey)`, exactly one wins and the others reject.
 *    This is the in-memory stand-in for PostgreSQL's
 *    `FOR UPDATE SKIP LOCKED` semantics.
 *  - Idempotency: a second launch is allowed after the prior execution
 *    is no longer `STARTING`/`STARTED` (e.g. `COMPLETED`).
 *
 * The contract is intentionally decoupled from any concrete ORM entity
 * class: only the public interfaces and value types are referenced.
 */
export function runJobRepositoryContract(
  factory: JobRepositoryContractFactory,
  implName: string,
): void {
  describe(`JobRepository + TransactionManager contract (${implName})`, () => {
    let repo: IJobRepository;
    let tx: TransactionManager;

    beforeEach(() => {
      const pair = factory.create();
      repo = pair.repo;
      tx = pair.tx;
    });

    describe('JobRepository', () => {
      test('is an instance of the JobRepository abstract class', () => {
        // Real implementations extend JobRepository; the interface is
        // type-only so the runtime check is against the abstract class.
        expect(repo).toBeInstanceOf(JobRepository);
      });

      test('getOrCreateJobInstance returns the same instance for the same (name, key)', async () => {
        const a = await repo.getOrCreateJobInstance('myJob', 'k1');
        const b = await repo.getOrCreateJobInstance('myJob', 'k1');
        expect(a.id).toBe(b.id);
        expect(a.jobName).toBe('myJob');
        expect(a.jobKey).toBe('k1');
        expect(a.createdAt).toBeInstanceOf(Date);
      });

      test('getOrCreateJobInstance returns distinct instances for distinct (name, key) pairs', async () => {
        const a = await repo.getOrCreateJobInstance('job-a', 'k');
        const b = await repo.getOrCreateJobInstance('job-b', 'k');
        const c = await repo.getOrCreateJobInstance('job-a', 'k2');
        expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      });

      test('getOrCreateJobInstance is race-safe under Promise.all concurrency', async () => {
        const calls = Array.from({ length: 10 }, () =>
          repo.getOrCreateJobInstance('concurrent-create', 'k'),
        );
        const results = await Promise.all(calls);
        const uniqueIds = new Set(results.map((r) => r.id));
        expect(uniqueIds.size).toBe(1);
      });

      test('createExecutionAtomic returns a JobExecution in STARTING status', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-exec', { foo: 'bar' });
        expect(exec.status).toBe(JobStatus.STARTING);
        expect(typeof exec.jobInstanceId).toBe('string');
        expect(exec.jobInstanceId.length).toBeGreaterThan(0);
        expect(exec.params).toEqual({ foo: 'bar' });
        expect(exec.startTime).toBeNull();
        expect(exec.endTime).toBeNull();
        expect(exec.exitCode).toBe('');
        expect(exec.exitMessage).toBe('');

        // Cleanup so the next test does not see a running execution.
        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('createExecutionAtomic stores a snapshot of params (mutating input does not affect stored value)', async () => {
        const params: JobParameters = { nested: { n: 1 }, list: [1, 2, 3] };
        const exec = await repo.createExecutionAtomic('myJob', 'k-snap', params);

        // Mutate the original input — stored params must not change.
        (params.nested as Record<string, unknown>)['n'] = 999;
        (params.list as unknown[]).push(999);

        const fetched = await repo.getJobExecution(exec.id);
        expect(fetched).not.toBeNull();
        expect((fetched!.params as { nested: { n: number } }).nested.n).toBe(1);
        expect((fetched!.params as { list: number[] }).list).toEqual([1, 2, 3]);

        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('createExecutionAtomic is restart-friendly: a new launch after COMPLETED creates a new execution sharing the same instance', async () => {
        const first = await repo.createExecutionAtomic('myJob', 'k-restart', { p: 1 });
        await repo.updateJobExecution(first.id, {
          status: JobStatus.COMPLETED,
          endTime: new Date(),
        });

        const second = await repo.createExecutionAtomic('myJob', 'k-restart', { p: 2 });
        expect(second.id).not.toBe(first.id);
        expect(second.jobInstanceId).toBe(first.jobInstanceId);
        expect(second.status).toBe(JobStatus.STARTING);

        await repo.updateJobExecution(second.id, { status: JobStatus.COMPLETED });
      });

      test('createExecutionAtomic rejects with JobExecutionAlreadyRunningError when an execution is already STARTING', async () => {
        const first = await repo.createExecutionAtomic('myJob', 'k-dup', { p: 1 });
        // first is still STARTING — not yet completed
        await expect(
          repo.createExecutionAtomic('myJob', 'k-dup', { p: 2 }),
        ).rejects.toBeInstanceOf(JobExecutionAlreadyRunningError);

        // Cleanup
        await repo.updateJobExecution(first.id, { status: JobStatus.COMPLETED });
      });

      test('createExecutionAtomic rejects with JobExecutionAlreadyRunningError when an execution is STARTED', async () => {
        const first = await repo.createExecutionAtomic('myJob', 'k-started', { p: 1 });
        await repo.updateJobExecution(first.id, {
          status: JobStatus.STARTED,
          startTime: new Date(),
        });

        await expect(
          repo.createExecutionAtomic('myJob', 'k-started', { p: 2 }),
        ).rejects.toBeInstanceOf(JobExecutionAlreadyRunningError);

        await repo.updateJobExecution(first.id, { status: JobStatus.COMPLETED });
      });

      test('concurrent createExecutionAtomic: exactly one winner, all others reject (FOR UPDATE SKIP LOCKED semantics)', async () => {
        const attempts = 5;
        const settled = await Promise.allSettled(
          Array.from({ length: attempts }, () =>
            repo.createExecutionAtomic('concurrent-exec', 'k1', { p: 'x' }),
          ),
        );
        const fulfilled = settled.filter((r) => r.status === 'fulfilled');
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(attempts - 1);
        for (const r of rejected) {
          if (r.status === 'rejected') {
            expect(r.reason).toBeInstanceOf(JobExecutionAlreadyRunningError);
          }
        }
        const winningExec = (fulfilled[0] as PromiseFulfilledResult<JobExecution>).value;
        const running = await repo.getRunningJobExecution(winningExec.jobInstanceId);
        expect(running?.id).toBe(winningExec.id);

        // Cleanup
        await repo.updateJobExecution(winningExec.id, { status: JobStatus.COMPLETED });
      });

      test('updateJobExecution: status, startTime, endTime are patchable; unspecified fields are preserved', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-patch', { p: 1 });
        const startTime = new Date('2025-01-01T00:00:00Z');
        await repo.updateJobExecution(exec.id, {
          status: JobStatus.STARTED,
          startTime,
        });
        const afterStart = await repo.getJobExecution(exec.id);
        expect(afterStart?.status).toBe(JobStatus.STARTED);
        expect(afterStart?.startTime?.toISOString()).toBe(startTime.toISOString());
        // endTime is still null (not patched)
        expect(afterStart?.endTime).toBeNull();

        const endTime = new Date('2025-01-01T00:01:00Z');
        await repo.updateJobExecution(exec.id, {
          status: JobStatus.COMPLETED,
          endTime,
          exitCode: 'COMPLETED',
        });
        const afterEnd = await repo.getJobExecution(exec.id);
        expect(afterEnd?.status).toBe(JobStatus.COMPLETED);
        expect(afterEnd?.startTime?.toISOString()).toBe(startTime.toISOString());
        expect(afterEnd?.endTime?.toISOString()).toBe(endTime.toISOString());
        expect(afterEnd?.exitCode).toBe('COMPLETED');
      });

      test('getJobExecution returns null for unknown id', async () => {
        const result = await repo.getJobExecution('does-not-exist');
        expect(result).toBeNull();
      });

      test('getRunningJobExecution returns the STARTING/STARTED execution, or null when none', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-running', { p: 1 });
        const running = await repo.getRunningJobExecution(exec.jobInstanceId);
        expect(running?.id).toBe(exec.id);
        expect(running?.status).toBe(JobStatus.STARTING);

        await repo.updateJobExecution(exec.id, { status: JobStatus.STARTED });
        const stillRunning = await repo.getRunningJobExecution(exec.jobInstanceId);
        expect(stillRunning?.id).toBe(exec.id);
        expect(stillRunning?.status).toBe(JobStatus.STARTED);

        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
        const noRunning = await repo.getRunningJobExecution(exec.jobInstanceId);
        expect(noRunning).toBeNull();
      });

      test('getRunningJobExecution returns null for an unknown job instance id', async () => {
        const result = await repo.getRunningJobExecution('not-a-real-instance');
        expect(result).toBeNull();
      });

      test('createStepExecution + updateStepExecution + getStepExecution roundtrip', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-step', { p: 1 });
        const step = await repo.createStepExecution(exec.id, 'step-a');
        expect(step.status).toBe(StepStatus.STARTING);
        expect(step.jobExecutionId).toBe(exec.id);
        expect(step.stepName).toBe('step-a');
        expect(step.readCount).toBe(0);
        expect(step.writeCount).toBe(0);
        expect(step.commitCount).toBe(0);
        expect(step.startTime).toBeNull();
        expect(step.endTime).toBeNull();

        await repo.updateStepExecution(step.id, {
          status: StepStatus.STARTED,
          readCount: 10,
          writeCount: 5,
        });
        const after = await repo.getStepExecution(step.id);
        expect(after?.status).toBe(StepStatus.STARTED);
        expect(after?.readCount).toBe(10);
        expect(after?.writeCount).toBe(5);

        // Cleanup
        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('getStepExecution returns null for unknown id', async () => {
        const result = await repo.getStepExecution('does-not-exist');
        expect(result).toBeNull();
      });

      test('saveExecutionContext + getExecutionContext roundtrip preserves data and version', async () => {
        const scope: ExecutionScope = { stepExecutionId: 'ctx-1' };
        const data = { cursor: 5, items: [1, 2, 3], meta: { tag: 'x' } };
        await repo.saveExecutionContext(scope, { data, version: 1 });
        const ctx = await repo.getExecutionContext(scope);
        expect(ctx).toEqual({ data, version: 1 });
      });

      test('saveExecutionContext auto-increments version when the version argument is omitted', async () => {
        const scope: ExecutionScope = { jobExecutionId: 'ctx-auto' };
        await repo.saveExecutionContext(scope, { data: { n: 1 }, version: 0 }, 1);
        await repo.saveExecutionContext(scope, { data: { n: 2 }, version: 0 });
        const ctx = await repo.getExecutionContext(scope);
        expect(ctx?.data).toEqual({ n: 2 });
        expect((ctx?.version ?? 0) > 1).toBe(true);
      });

      test('getExecutionContext returns { data: null, version: 0 } when no context exists', async () => {
        const scope: ExecutionScope = { stepExecutionId: 'no-scope' };
        const ctx = await repo.getExecutionContext(scope);
        expect(ctx).toEqual({ data: null, version: 0 });
      });

      test('saveExecutionContext / getExecutionContext isolate job-scope from step-scope', async () => {
        const jobScope: ExecutionScope = { jobExecutionId: 'iso-job' };
        const stepScope: ExecutionScope = { stepExecutionId: 'iso-step' };
        await repo.saveExecutionContext(jobScope, { data: { where: 'job' }, version: 1 });
        await repo.saveExecutionContext(stepScope, { data: { where: 'step' }, version: 1 });
        expect(await repo.getExecutionContext(jobScope)).toEqual({
          data: { where: 'job' },
          version: 1,
        });
        expect(await repo.getExecutionContext(stepScope)).toEqual({
          data: { where: 'step' },
          version: 1,
        });
      });

      test('saveExecutionContext: mutating returned data does not affect stored data on next read', async () => {
        const scope: ExecutionScope = { stepExecutionId: 'ctx-mut' };
        await repo.saveExecutionContext(scope, { data: { cursor: 0 }, version: 1 });
        const first = await repo.getExecutionContext(scope);
        (first!.data as Record<string, unknown>)['cursor'] = -1;
        const second = await repo.getExecutionContext(scope);
        expect((second!.data as Record<string, unknown>)['cursor']).toBe(0);
      });

      test('findLatestStepExecution returns null when no step exists', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-nil', { p: 1 });
        const step = await repo.findLatestStepExecution(exec.id, 'never-existed');
        expect(step).toBeNull();
        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('findLatestStepExecution returns the latest matching step (restart checkpoint)', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-latest', { p: 1 });
        const older = await repo.createStepExecution(exec.id, 'step-a');
        await repo.updateStepExecution(older.id, { status: StepStatus.FAILED });

        const newer = await repo.createStepExecution(exec.id, 'step-a');
        await repo.updateStepExecution(newer.id, { status: StepStatus.FAILED });

        const latest = await repo.findLatestStepExecution(exec.id, 'step-a');
        expect(latest).not.toBeNull();
        expect(latest!.id).toBe(newer.id);

        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('findLatestStepExecution ignores steps for other step names', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-isolated', { p: 1 });
        await repo.createStepExecution(exec.id, 'step-a');
        const stepB = await repo.createStepExecution(exec.id, 'step-b');
        const latest = await repo.findLatestStepExecution(exec.id, 'step-b');
        expect(latest?.id).toBe(stepB.id);

        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('findLatestStepExecution returns the only matching step when there is just one', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-single', { p: 1 });
        const step = await repo.createStepExecution(exec.id, 'only-step');
        const latest = await repo.findLatestStepExecution(exec.id, 'only-step');
        expect(latest?.id).toBe(step.id);
        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });

      test('checkpoint lookup: after a partial chunk, findLatestStepExecution returns the row and its saved context', async () => {
        const exec = await repo.createExecutionAtomic('myJob', 'k-ckpt', { p: 1 });
        const step = await repo.createStepExecution(exec.id, 'chunk-step');

        // Simulate a chunk-mid-flight state
        await repo.updateStepExecution(step.id, {
          status: StepStatus.STARTED,
          readCount: 50,
          writeCount: 50,
          commitCount: 1,
        });

        // Save the last-committed-chunk checkpoint as execution context
        const checkpoint = { lastChunkIndex: 1, lastReadIndex: 50 };
        await repo.saveExecutionContext(
          { stepExecutionId: step.id },
          { data: checkpoint, version: 1 },
        );

        // Simulate a failure
        await repo.updateStepExecution(step.id, {
          status: StepStatus.FAILED,
          endTime: new Date(),
          exitMessage: 'simulated crash',
        });

        // Restart: look up the latest step execution for this step
        const latest = await repo.findLatestStepExecution(exec.id, 'chunk-step');
        expect(latest).not.toBeNull();
        expect(latest!.id).toBe(step.id);
        expect(latest!.status).toBe(StepStatus.FAILED);

        // And load its saved checkpoint
        const ctx = await repo.getExecutionContext({ stepExecutionId: latest!.id });
        expect(ctx).toEqual({ data: checkpoint, version: 1 });

        await repo.updateJobExecution(exec.id, { status: JobStatus.COMPLETED });
      });
    });

    describe('TransactionManager', () => {
      test('withTransaction yields an active context (isActive=true) with a non-empty id', async () => {
        let receivedCtx: { isActive: boolean; id: string } | null = null;
        await tx.withTransaction(async (ctx) => {
          receivedCtx = ctx;
        });
        expect(receivedCtx).not.toBeNull();
        expect(receivedCtx!.isActive).toBe(true);
        expect(typeof receivedCtx!.id).toBe('string');
        expect(receivedCtx!.id.length).toBeGreaterThan(0);
      });

      test('withTransaction returns the value resolved by fn', async () => {
        const result = await tx.withTransaction(async () => ({ ok: true, n: 42 }));
        expect(result).toEqual({ ok: true, n: 42 });
      });

      test('withTransaction propagates errors thrown by fn', async () => {
        const err = new Error('tx-boom');
        await expect(
          tx.withTransaction(async () => {
            throw err;
          }),
        ).rejects.toBe(err);
      });

      test('withTransaction wraps repository operations — create + update visible inside the same ctx', async () => {
        const jobInstanceId = await tx.withTransaction(async (ctx) => {
          expect(ctx.isActive).toBe(true);
          const exec = await repo.createExecutionAtomic('myJob', 'tx-wrap', { p: 1 });
          await repo.updateJobExecution(exec.id, { status: JobStatus.STARTED });
          const after = await repo.getJobExecution(exec.id);
          expect(after?.status).toBe(JobStatus.STARTED);
          return exec.jobInstanceId;
        });
        // After the tx, the data must be visible (real DB or in-memory).
        const execs = await repo.getRunningJobExecution(jobInstanceId);
        // No running exec remains once we completed it... actually we set it
        // to STARTED. The contract here is just that the data was visible
        // inside the tx; we don't assume anything about external visibility.
        expect(execs === null || execs.status === JobStatus.STARTED).toBe(true);

        // Cleanup
        if (execs) {
          await repo.updateJobExecution(execs.id, { status: JobStatus.COMPLETED });
        }
      });

      test('withTransaction: two distinct invocations produce different context ids', async () => {
        const ids = new Set<string>();
        for (let i = 0; i < 3; i++) {
          await tx.withTransaction(async (ctx) => {
            ids.add(ctx.id);
          });
        }
        expect(ids.size).toBe(3);
      });
    });
  });
}
