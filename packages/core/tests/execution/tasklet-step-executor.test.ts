import { describe, expect, test } from 'vitest';
import {
  TaskletStepExecutor,
  type TaskletExecutionContext,
  type StepExecutionResult,
} from '../../src/execution/tasklet-step-executor';
import { ListenerInvoker, type ListenerResolver } from '../../src/execution/listener-invoker';
import { RefKind, type TaskletRef, type TaskletStepDefinition } from '../../src/core/ir';
import { StepStatus } from '../../src/core/status';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import {
  type TransactionContext,
  TransactionManager,
} from '../../src/core/transaction/transaction-manager';
import type { JobParameters } from '../../src/core/repository';

/**
 * Build a minimal TaskletExecutionContext wired up with the in-memory
 * adapter implementations. Tests pass their own `listeners` map and
 * `transactionManager` to control the behaviour under test.
 */
function makeContext(overrides: {
  listeners?: Map<string, ListenerResolver>;
  jobParameters?: JobParameters;
  transactionManager?: TransactionManager;
}): TaskletExecutionContext {
  return {
    jobExecutionId: 'job-exec-1',
    stepExecutionId: 'step-exec-1',
    stepName: 'tasklet-step-1',
    ...(overrides.jobParameters ? { jobParameters: overrides.jobParameters } : {}),
    jobRepository: new InMemoryJobRepository(),
    transactionManager: overrides.transactionManager ?? new InMemoryTransactionManager(),
    listenerInvoker: new ListenerInvoker(),
    listenerResolvers: overrides.listeners ?? new Map<string, ListenerResolver>(),
  };
}

function makeTaskletStep(fn: (ctx: unknown) => Promise<unknown> | unknown): TaskletStepDefinition {
  const ref: TaskletRef = {
    kind: RefKind.BuilderLambda,
    fn: () => ({ execute: fn }),
  };
  return {
    kind: 'tasklet',
    id: 'tasklet-step-1',
    tasklet: ref,
    listeners: [],
  };
}

describe('TaskletStepExecutor', () => {
  test('simple tasklet that returns "DONE" → status COMPLETED, exitMessage contains the return value', async () => {
    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => 'DONE');

    const result: StepExecutionResult = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    expect(result.exitMessage).toBe('DONE');
    expect(result.readCount).toBe(0);
    expect(result.writeCount).toBe(0);
    expect(result.skipCount).toBe(0);
  });

  test('tasklet receives TaskletContext with launch jobParameters', async () => {
    const seen: unknown[] = [];
    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep((ctx) => {
      seen.push(ctx);
      return 'OK';
    });

    const result = await executor.execute(
      step,
      makeContext({ jobParameters: { file: 'launch-param.csv' } }),
    );

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      jobExecutionId: 'job-exec-1',
      stepExecutionId: 'step-exec-1',
      jobParameters: { file: 'launch-param.csv' },
    });
  });

  test('tasklet that returns undefined → status COMPLETED, exitMessage is empty string', async () => {
    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => undefined);

    const result = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    // undefined is normalised to '' (NOT the string "undefined") so callers
    // can rely on exitMessage being either empty or a meaningful return value.
    expect(result.exitMessage).toBe('');
  });

  test('tasklet that throws → status FAILED, exitMessage contains the error message', async () => {
    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => {
      throw new Error('boom-tasklet');
    });

    const result = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toContain('boom-tasklet');
  });

  test('tasklet that throws a non-Error value (string) → status FAILED, exitMessage is the string', async () => {
    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain-string-error';
    });

    const result = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitMessage).toBe('plain-string-error');
  });

  test('before/after listeners invoked in correct order around the tasklet', async () => {
    const callOrder: string[] = [];

    const resolvers = new Map<string, ListenerResolver>();
    resolvers.set('before-step:before', async () => {
      callOrder.push('before');
    });
    resolvers.set('after-step:after', async () => {
      callOrder.push('after');
    });
    // a non-matching phase key to ensure it's ignored
    resolvers.set('chunk-listener:ignored', async () => {
      callOrder.push('IGNORED');
    });

    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => {
      callOrder.push('tasklet');
    });

    const result = await executor.execute(step, makeContext({ listeners: resolvers }));

    expect(callOrder).toEqual(['before', 'tasklet', 'after']);
    expect(result.status).toBe(StepStatus.COMPLETED);
  });

  test('after-step listener receives the StepExecutionResult as second arg', async () => {
    const seen: Array<{ ctx: unknown; result: unknown }> = [];
    const resolvers = new Map<string, ListenerResolver>();
    resolvers.set('after-step:observer', async (ctx, result) => {
      seen.push({ ctx, result });
    });

    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => 'OK');

    await executor.execute(step, makeContext({ listeners: resolvers }));

    expect(seen).toHaveLength(1);
    // The listener receives the LIVE `result` object so it can mutate
    // the outcome. Read/write/skip counts ride along on the same
    // object — the listener typically ignores them.
    expect(seen[0]?.result).toMatchObject({
      status: StepStatus.COMPLETED,
      exitCode: 'COMPLETED',
      exitMessage: 'OK',
    });
    expect((seen[0]?.result as { readCount: number }).readCount).toBe(0);
  });

  test('on-step-error listener is invoked when tasklet throws, after-step still runs', async () => {
    const callOrder: string[] = [];
    const resolvers = new Map<string, ListenerResolver>();
    resolvers.set('before-step:b', async () => {
      callOrder.push('before');
    });
    resolvers.set('on-step-error:e', async (_ctx, err) => {
      callOrder.push('onError');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('explode');
    });
    resolvers.set('after-step:a', async () => {
      callOrder.push('after');
    });

    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => {
      callOrder.push('tasklet');
      throw new Error('explode');
    });

    const result = await executor.execute(step, makeContext({ listeners: resolvers }));

    expect(callOrder).toEqual(['before', 'tasklet', 'onError', 'after']);
    expect(result.status).toBe(StepStatus.FAILED);
  });

  test('withTransaction wraps the tasklet call (mock TM records the call)', async () => {
    const tm = new RecordingTransactionManager();

    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => 'IN_TX');

    const result = await executor.execute(step, makeContext({ transactionManager: tm }));

    expect(tm.calls).toHaveLength(1);
    // The fn passed to withTransaction was invoked exactly once.
    expect(tm.calls[0]?.invoked).toBe(true);
    // The result the tasklet returned is the one propagated out.
    expect(tm.calls[0]?.returnValue).toBe('IN_TX');
    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitMessage).toBe('IN_TX');
  });

  test('withTransaction wraps a failing tasklet — error propagates out and the call is recorded', async () => {
    const tm = new RecordingTransactionManager();
    const boom = new Error('tx-boom');

    const executor = new TaskletStepExecutor();
    const step = makeTaskletStep(async () => {
      throw boom;
    });

    const result = await executor.execute(step, makeContext({ transactionManager: tm }));

    expect(tm.calls).toHaveLength(1);
    expect(tm.calls[0]?.invoked).toBe(true);
    expect(tm.calls[0]?.threw).toBe(true);
    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitMessage).toContain('tx-boom');
  });

  test('non-builder-lambda tasklet ref (method kind) is surfaced as a FAILED result with the resolution error', async () => {
    const executor = new TaskletStepExecutor();
    const step: TaskletStepDefinition = {
      kind: 'tasklet',
      id: 'bad-step',
      tasklet: { kind: RefKind.Method, classToken: 'MyJob', methodName: 'run' },
      listeners: [],
    };

    const result = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitMessage).toMatch(/Tasklet resolution not supported for ref kind: method/);
  });

  test('executor returns synchronously resolvable (non-Promise) tasklet results', async () => {
    const executor = new TaskletStepExecutor();
    // sync return — fn is still async-signature on Tasklet.execute, but the
    // function can resolve immediately.
    const step = makeTaskletStep(() => 42);

    const result = await executor.execute(step, makeContext({}));

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitMessage).toBe('42');
  });
});

/**
 * Mock TransactionManager that records every `withTransaction` call so tests
 * can assert that the executor wrapped the tasklet in a transaction.
 */
class RecordingTransactionManager extends TransactionManager {
  readonly calls: Array<{ invoked: boolean; returnValue: unknown; threw: boolean }> = [];

  override async withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const ctx: TransactionContext = { isActive: true, id: 'mock-tx-id' };
    let returnValue: unknown = undefined;
    let threw = false;
    try {
      returnValue = await fn(ctx);
    } catch (err) {
      threw = true;
      this.calls.push({ invoked: true, returnValue, threw: true });
      throw err;
    }
    this.calls.push({ invoked: true, returnValue, threw: false });
    return returnValue as T;
  }
}
