import { describe, expect, test, vi } from 'vitest';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker, type ListenerResolver } from '../../src/execution/listener-invoker';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { RefKind, type JobDefinition, type TaskletStepDefinition, type TaskletRef } from '../../src/core/ir';
import { JobStatus, StepStatus, FlowExecutionStatus } from '../../src/core/status';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a one-tasklet JobDefinition with the given id and an array of
 * transition literals. `startStepId` defaults to the first step.
 */
function makeJobDef(
  id: string,
  steps: Record<string, TaskletStepDefinition>,
  transitions: JobDefinition['transitions'] = [],
  startStepId?: string,
): JobDefinition {
  return {
    id,
    steps,
    startStepId: startStepId ?? Object.keys(steps)[0]!,
    transitions,
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

/**
 * Build a `TaskletStepDefinition` whose `execute()` calls `fn`.
 */
function makeTaskletStep(stepId: string, fn: () => Promise<unknown> | unknown): TaskletStepDefinition {
  const ref: TaskletRef = {
    kind: RefKind.BuilderLambda,
    fn: () => ({ execute: fn }),
  };
  return { kind: 'tasklet', id: stepId, tasklet: ref, listeners: [] };
}

/**
 * Wire a full JobExecutor against the in-memory adapter implementations.
 * The `listenerResolvers` map is forwarded to the TaskletStepExecutor so
 * tests can register `after-step:*` listeners that mutate the result.
 */
function makeExecutor(listenerResolvers?: Map<string, ListenerResolver>): {
  executor: JobExecutor;
  repository: InMemoryJobRepository;
} {
  const repository = new InMemoryJobRepository();
  const transactionManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const taskletExecutor = new TaskletStepExecutor();
  const chunkExecutor = new ChunkStepExecutor();
  const flowEvaluator = new FlowEvaluator();
  const executor = new JobExecutor(
    repository,
    transactionManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
    // listenerResolvers is passed via the per-call arg in
    // TaskletStepExecutor.execute; see makeStartedExecution below.
  );
  // Stash for tests that want to inspect.
  void listenerResolvers;
  return { executor, repository };
}

/**
 * Create a `JobExecution` in the in-memory repository so
 * `JobExecutor.execute` can be called directly. Returns the execution
 * and the repository for further assertions.
 */
async function makeStartedExecution(repository: InMemoryJobRepository, jobName = 'test-job') {
  const instance = await repository.getOrCreateJobInstance(jobName, 'key-1');
  const execution = await repository.createJobExecution(instance.id, { foo: 'bar' });
  return execution;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobExecutor', () => {
  // -------------------------------------------------------------------------
  // 1) Trivial 1-step tasklet job → COMPLETED
  // -------------------------------------------------------------------------
  test('1) 1-step tasklet job → execution status COMPLETED, step runs exactly once', async () => {
    const { executor, repository } = makeExecutor();
    const runSpy = vi.fn(async () => 'ok');
    const jobDef = makeJobDef('one-step', {
      s1: makeTaskletStep('s1', runSpy),
    });

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(result.endTime).toBeInstanceOf(Date);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2) Step throws → execution FAILED, exitMessage captures the error
  // -------------------------------------------------------------------------
  test('2) step throws → execution FAILED, exitMessage contains the error', async () => {
    const { executor, repository } = makeExecutor();
    const jobDef = makeJobDef('one-step-throws', {
      s1: makeTaskletStep('s1', async () => {
        throw new Error('step1-boom');
      }),
    });

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.exitMessage).toContain('step1-boom');
    expect(result.endTime).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // 3) Linear flow (no explicit transitions) runs every step in order
  // -------------------------------------------------------------------------
  test('3) 2-step linear job with no explicit transitions runs both steps in order', async () => {
    const { executor, repository } = makeExecutor();
    const order: string[] = [];
    const jobDef = makeJobDef('linear', {
      s1: makeTaskletStep('s1', async () => {
        order.push('s1');
        return 'a';
      }),
      s2: makeTaskletStep('s2', async () => {
        order.push('s2');
        return 'b';
      }),
    });

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(order).toEqual(['s1', 's2']);
  });

  // -------------------------------------------------------------------------
  // 4) .on(FAILED).to('recovery') routes step1 failure into the recovery step
  // -------------------------------------------------------------------------
  test('4) 2-step job with .on(FAILED).to("recovery") — step1 fails, recovery runs', async () => {
    const { executor, repository } = makeExecutor();
    const calls: string[] = [];
    const jobDef = makeJobDef('with-recovery', {
      s1: makeTaskletStep('s1', async () => {
        calls.push('s1');
        throw new Error('primary-boom');
      }),
      recovery: makeTaskletStep('recovery', async () => {
        calls.push('recovery');
        return 'recovered';
      }),
    });
    jobDef.transitions = [
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.FAILED,
        toStepId: 'recovery',
      },
    ];

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(calls).toEqual(['s1', 'recovery']);
    expect(result.status).toBe(JobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------
  // 5) .on(COMPLETED).end() — job ends after step1 (no step2 executed)
  // -------------------------------------------------------------------------
  test('5) 2-step job with .on(COMPLETED).end() after step1 → job ends after step1', async () => {
    const { executor, repository } = makeExecutor();
    const calls: string[] = [];
    const jobDef = makeJobDef('end-after-s1', {
      s1: makeTaskletStep('s1', async () => {
        calls.push('s1');
        return 'done';
      }),
      s2: makeTaskletStep('s2', async () => {
        calls.push('s2');
        return 'never';
      }),
    });
    jobDef.transitions = [
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.COMPLETED,
        toStepId: null, // .end()
      },
    ];

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(calls).toEqual(['s1']);
    expect(result.status).toBe(JobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------
  // 6) Step fails with no matching transition → job FAILED, no recovery
  // -------------------------------------------------------------------------
  test('6) step1 fails, no matching transition → job FAILED, step2 never runs', async () => {
    const { executor, repository } = makeExecutor();
    const calls: string[] = [];
    const jobDef = makeJobDef('no-recovery', {
      s1: makeTaskletStep('s1', async () => {
        calls.push('s1');
        throw new Error('no-safety-net');
      }),
      s2: makeTaskletStep('s2', async () => {
        calls.push('s2');
        return 'unreachable';
      }),
    });
    // Only COMPLETED has a transition; FAILED has none → short-circuit.
    jobDef.transitions = [
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.COMPLETED,
        toStepId: 's2',
      },
    ];

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(calls).toEqual(['s1']);
    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.exitMessage).toContain('no-safety-net');
  });

  // -------------------------------------------------------------------------
  // 7) afterStep listener can override the step status (per ORACLE 3c)
  // -------------------------------------------------------------------------
  test('7) after-step listener overrides status: COMPLETED → FAILED steers into recovery branch', async () => {
    const repository = new InMemoryJobRepository();
    const transactionManager = new InMemoryTransactionManager();
    const listenerInvoker = new ListenerInvoker();
    const taskletExecutor = new TaskletStepExecutor();
    const chunkExecutor = new ChunkStepExecutor();
    const flowEvaluator = new FlowEvaluator();
    const executor = new JobExecutor(
      repository,
      transactionManager,
      taskletExecutor,
      chunkExecutor,
      listenerInvoker,
      flowEvaluator,
    );

    // Per-call listenerResolvers: after-step mutates the LIVE result
    // object so the JobExecutor's transition evaluation sees FAILED.
    // We only flip s1's status; the recovery step's status stays as-is
    // so the job can reach COMPLETED.
    const listenerResolvers = new Map<string, ListenerResolver>();
    listenerResolvers.set('after-step:override-s1', async (_ctx, result) => {
      const r = result as { status: StepStatus; exitMessage: string };
      if (r.exitMessage === 'would-be-ok') {
        r.status = StepStatus.FAILED;
      }
    });

    // Patch the executor so its per-call listenerResolvers map is the
    // one we built. This is the test-only injection seam.
    const originalExecute = taskletExecutor.execute.bind(taskletExecutor);
    (taskletExecutor as unknown as { execute: typeof originalExecute }).execute = ((
      step: TaskletStepDefinition,
      context: Parameters<typeof originalExecute>[1],
    ) => {
      return originalExecute(step, { ...context, listenerResolvers });
    }) as typeof originalExecute;

    const calls: string[] = [];
    const jobDef = makeJobDef('override', {
      s1: makeTaskletStep('s1', async () => {
        calls.push('s1');
        return 'would-be-ok';
      }),
      recovery: makeTaskletStep('recovery', async () => {
        calls.push('recovery');
        return 'recovered';
      }),
    });
    jobDef.transitions = [
      { fromStepId: 's1', onStatus: FlowExecutionStatus.FAILED, toStepId: 'recovery' },
    ];

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    // The override re-routes s1 → recovery instead of completing the
    // job directly.
    expect(calls).toEqual(['s1', 'recovery']);
    expect(result.status).toBe(JobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------
  // 8) 3-step linear job: every step runs, end-to-end completion
  // -------------------------------------------------------------------------
  test('8) 3-step linear job runs s1 → s2 → s3 in order and reaches COMPLETED', async () => {
    const { executor, repository } = makeExecutor();
    const order: string[] = [];
    const jobDef = makeJobDef('three-step', {
      s1: makeTaskletStep('s1', async () => {
        order.push('s1');
        return 'a';
      }),
      s2: makeTaskletStep('s2', async () => {
        order.push('s2');
        return 'b';
      }),
      s3: makeTaskletStep('s3', async () => {
        order.push('s3');
        return 'c';
      }),
    });

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(order).toEqual(['s1', 's2', 's3']);
    expect(result.status).toBe(JobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------
  // 9) startStepId points to a missing step → FAILED with NO_SUCH_STEP
  // -------------------------------------------------------------------------
  test('9) startStepId references a missing step → FAILED with exitCode NO_SUCH_STEP', async () => {
    const { executor, repository } = makeExecutor();
    const jobDef = makeJobDef('broken', {
      s1: makeTaskletStep('s1', async () => 'never'),
    });
    // Override the startStepId to point at a step that doesn't exist.
    jobDef.startStepId = 'ghost';

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.exitCode).toBe('NO_SUCH_STEP');
    expect(result.exitMessage).toContain('ghost');
  });

  // -------------------------------------------------------------------------
  // 10) JobExecution has STARTED → COMPLETED timestamps, and params roundtrip
  // -------------------------------------------------------------------------
  test('10) successful execution persists startTime + endTime, and params are preserved', async () => {
    const { executor, repository } = makeExecutor();
    const jobDef = makeJobDef('with-params', {
      s1: makeTaskletStep('s1', async () => 'OK'),
    });

    const instance = await repository.getOrCreateJobInstance('with-params', 'k');
    const execution = await repository.createJobExecution(instance.id, { p: 42 });
    const result = await executor.execute(execution, jobDef);

    expect(result.startTime).toBeInstanceOf(Date);
    expect(result.endTime).toBeInstanceOf(Date);
    expect(result.params).toEqual({ p: 42 });
    expect(result.status).toBe(JobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------
  // 11) Recovery step itself fails → FAILED propagates (nested failure)
  // -------------------------------------------------------------------------
  test('11) recovery step itself fails with no further transition → FAILED, both steps attempted', async () => {
    const { executor, repository } = makeExecutor();
    const calls: string[] = [];
    const jobDef = makeJobDef('recovery-fails', {
      s1: makeTaskletStep('s1', async () => {
        calls.push('s1');
        throw new Error('primary');
      }),
      recovery: makeTaskletStep('recovery', async () => {
        calls.push('recovery');
        throw new Error('recovery-also-broken');
      }),
    });
    jobDef.transitions = [
      { fromStepId: 's1', onStatus: FlowExecutionStatus.FAILED, toStepId: 'recovery' },
      // No FAILED transition from `recovery` → it should short-circuit.
    ];

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(calls).toEqual(['s1', 'recovery']);
    expect(result.status).toBe(JobStatus.FAILED);
    expect(result.exitMessage).toContain('recovery-also-broken');
  });

  // -------------------------------------------------------------------------
  // 12) 1-step tasklet that completes successfully persists exitCode='COMPLETED'
  // (regression: the COMPLETED branch of updateJobExecution used to drop
  //  exitCode, leaving the DB row at the default empty string).
  // -------------------------------------------------------------------------
  test('12) 1-step tasklet that completes successfully persists exitCode="COMPLETED"', async () => {
    const { executor, repository } = makeExecutor();
    const jobDef = makeJobDef('exit-code-completed', {
      s1: makeTaskletStep('s1', async () => 'ok'),
    });

    const execution = await makeStartedExecution(repository);
    const result = await executor.execute(execution, jobDef);

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
  });
});
