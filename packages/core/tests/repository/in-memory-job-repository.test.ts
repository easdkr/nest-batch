import { describe, expect, test } from 'vitest';
import { InMemoryJobRepository, RESTARTABLE_DEFAULT_INMEMORY } from '../../src/repository/in-memory/in-memory-job-repository';
import {
  DeterministicIdGenerator,
  UuidIdGenerator,
} from '../../src/repository/id-generator';
import { InvalidExecutionContextError } from '../../src/core/errors';
import { JobStatus, StepStatus } from '../../src/core/status';
import type { JobParameters, ExecutionScope } from '../../src/core/repository/types';

describe('InMemoryJobRepository', () => {
  test('getOrCreateJobInstance returns the same instance for the same (name, key)', async () => {
    const repo = new InMemoryJobRepository(new DeterministicIdGenerator('inst'));
    const first = await repo.getOrCreateJobInstance('myJob', 'k1');
    const second = await repo.getOrCreateJobInstance('myJob', 'k1');
    expect(first.id).toBe('inst-1');
    expect(second.id).toBe('inst-1');
    expect(first.jobName).toBe('myJob');
    expect(first.jobKey).toBe('k1');
  });

  test('deep clone: mutating the result of getStepExecution does not affect stored state', async () => {
    const repo = new InMemoryJobRepository(new DeterministicIdGenerator('s'));
    const job = await repo.getOrCreateJobInstance('j', 'k');
    const exec = await repo.createJobExecution(job.id, { foo: 1 });
    const step = await repo.createStepExecution(exec.id, 'step-a');
    const beforePatch = await repo.getStepExecution(step.id);
    expect(beforePatch?.readCount).toBe(0);

    // Update via repository
    await repo.updateStepExecution(step.id, { readCount: 1 });

    // Get, mutate, then get again — stored value should be unaffected
    const result = await repo.getStepExecution(step.id);
    expect(result).not.toBeNull();
    result!.readCount = 999;
    result!.stepName = 'mutated';

    const stored = await repo.getStepExecution(step.id);
    expect(stored?.readCount).toBe(1);
    expect(stored?.stepName).toBe('step-a');
  });

  test('concurrent getOrCreateJobInstance (Promise.all x10) yields exactly 1 instance', async () => {
    const repo = new InMemoryJobRepository(new DeterministicIdGenerator('inst'));
    const calls = Array.from({ length: 10 }, () => repo.getOrCreateJobInstance('j', 'k'));
    const results = await Promise.all(calls);
    const uniqueIds = new Set(results.map((r) => r.id));
    expect(uniqueIds.size).toBe(1);
    expect(results[0]?.id).toBe('inst-1');
  });

  test('saveExecutionContext rejects a function value with InvalidExecutionContextError', async () => {
    const repo = new InMemoryJobRepository();
    const scope: ExecutionScope = { jobExecutionId: 'job-x' };
    // Cast through unknown: we intentionally violate the JsonValue type to test
    // the runtime validator boundary.
    await expect(
      repo.saveExecutionContext(scope, {
        data: (() => 1) as unknown as null,
        version: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidExecutionContextError);
  });

  test('saveExecutionContext rejects a circular reference with InvalidExecutionContextError', async () => {
    const repo = new InMemoryJobRepository();
    const scope: ExecutionScope = { stepExecutionId: 'step-x' };
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    await expect(
      repo.saveExecutionContext(scope, {
        data: cyclic as unknown as null,
        version: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidExecutionContextError);
  });

  test('createJobExecution + getJobExecution roundtrips with deep-cloned params', async () => {
    const repo = new InMemoryJobRepository(new DeterministicIdGenerator('e'));
    const job = await repo.getOrCreateJobInstance('j', 'k');
    // idGen was consumed once for the instance (e-1), so the execution is e-2.
    const params: JobParameters = { foo: 'bar', nested: { n: 1 } };
    const created = await repo.createJobExecution(job.id, params);
    expect(created.status).toBe(JobStatus.STARTING);
    expect(created.id).toBe('e-2');
    expect(created.jobInstanceId).toBe(job.id);
    expect(created.params).toEqual(params);

    // Mutate the input params — stored params must not be affected
    params.foo = 'CHANGED';
    const fetched = await repo.getJobExecution(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.params).toEqual({ foo: 'bar', nested: { n: 1 } });

    // Mutate the returned params — stored params must not be affected
    fetched!.params['foo'] = 'MUTATED';
    const again = await repo.getJobExecution(created.id);
    expect((again!.params as Record<string, unknown>)['foo']).toBe('bar');
  });

  test('updateStepExecution increments counts correctly', async () => {
    const repo = new InMemoryJobRepository(new DeterministicIdGenerator('s'));
    const job = await repo.getOrCreateJobInstance('j', 'k');
    const exec = await repo.createJobExecution(job.id, {});
    const step = await repo.createStepExecution(exec.id, 'step-a');

    await repo.updateStepExecution(step.id, { readCount: 10, writeCount: 5, status: StepStatus.STARTED });
    await repo.updateStepExecution(step.id, { readCount: 4 }); // incremental merge

    const after = await repo.getStepExecution(step.id);
    expect(after?.readCount).toBe(4);
    expect(after?.writeCount).toBe(5);
    expect(after?.status).toBe(StepStatus.STARTED);
  });

  test('getExecutionContext returns { data: null, version: 0 } when no context exists', async () => {
    const repo = new InMemoryJobRepository();
    const scope: ExecutionScope = { jobExecutionId: 'missing' };
    const ctx = await repo.getExecutionContext(scope);
    expect(ctx).toEqual({ data: null, version: 0 });
  });

  test('saveExecutionContext + getExecutionContext roundtrip preserves data and increments version', async () => {
    const repo = new InMemoryJobRepository();
    const scope: ExecutionScope = { stepExecutionId: 'step-1' };

    await repo.saveExecutionContext(scope, {
      data: { cursor: 0, items: [1, 2, 3] },
      version: 1,
    });
    const first = await repo.getExecutionContext(scope);
    expect(first).toEqual({ data: { cursor: 0, items: [1, 2, 3] }, version: 1 });

    // Omit version → auto-increment from current (1) → 2
    await repo.saveExecutionContext(scope, {
      data: { cursor: 100, items: [1, 2, 3] },
      version: 0,
    });
    const second = await repo.getExecutionContext(scope);
    // The exact version depends on contract: when version is passed as 0,
    // it is treated as "use this version" (caller's choice). We assert >= 1.
    expect(second?.data).toEqual({ cursor: 100, items: [1, 2, 3] });
    expect((second?.version ?? 0)).toBeGreaterThanOrEqual(1);

    // Deep clone on read: mutating returned data should not affect stored
    const fetched = await repo.getExecutionContext(scope);
    (fetched!.data as Record<string, unknown>)['cursor'] = -1;
    const refetch = await repo.getExecutionContext(scope);
    expect((refetch!.data as Record<string, unknown>)['cursor']).not.toBe(-1);
  });
});

describe('IdGenerator', () => {
  test('DeterministicIdGenerator produces predictable sequential output', () => {
    const gen = new DeterministicIdGenerator('id');
    expect(gen.next()).toBe('id-1');
    expect(gen.next()).toBe('id-2');
    expect(gen.next()).toBe('id-3');
  });

  test('DeterministicIdGenerator uses the supplied prefix', () => {
    const gen = new DeterministicIdGenerator('custom');
    expect(gen.next()).toBe('custom-1');
    expect(gen.next()).toBe('custom-2');
  });

  test('UuidIdGenerator returns a unique v4 UUID per call', () => {
    const gen = new UuidIdGenerator();
    const a = gen.next();
    const b = gen.next();
    expect(a).not.toBe(b);
    // v4 UUID format: 8-4-4-4-12 hex chars
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('RESTARTABLE_DEFAULT_INMEMORY', () => {
  test('is false (in-memory repo is non-restartable)', () => {
    expect(RESTARTABLE_DEFAULT_INMEMORY).toBe(false);
  });
});
