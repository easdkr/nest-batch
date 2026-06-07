import { describe, it, expect } from 'vitest';
import { JobLauncher } from '../../src/execution/job-launcher';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { JobRegistry } from '../../src/registry/job-registry';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { RefKind, type JobDefinition } from '../../src/core/ir';
import { JobExecutionAlreadyRunningError } from '@nest-batch/core';
import { JobStatus } from '../../src/core/status';

/**
 * Build a one-tasklet JobDefinition. By default the tasklet returns
 * `'ok'`. Pass `throwOnRun` to make it reject on the first call (used
 * by the FAILED-then-relaunch test).
 */
function makeTaskletJob(
  id: string,
  opts: { restartable?: boolean; throwOnRun?: boolean } = {},
): JobDefinition {
  return {
    id,
    steps: {
      s1: {
        kind: 'tasklet',
        id: 's1',
        tasklet: {
          kind: RefKind.BuilderLambda,
          fn: () => {
            if (opts.throwOnRun) {
              throw new Error('boom');
            }
            return 'ok';
          },
        },
        listeners: [],
      },
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: opts.restartable ?? false,
    allowDuplicateInstances: false,
  };
}

/**
 * Wire the full launcher dependency graph by hand — every dependency
 * is constructible directly and the launcher is a leaf consumer.
 */
function buildLauncher(registry: JobRegistry): {
  launcher: JobLauncher;
  repository: InMemoryJobRepository;
} {
  const repository = new InMemoryJobRepository();
  const transactionManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const taskletExecutor = new TaskletStepExecutor();
  const chunkExecutor = new ChunkStepExecutor();
  const flowEvaluator = new FlowEvaluator();
  const jobExecutor = new JobExecutor(
    repository,
    transactionManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
  const launcher = new JobLauncher(registry, repository, jobExecutor);
  return { launcher, repository };
}

describe('JobLauncher concurrency control', () => {
  it('rejects a second concurrent launch of the same jobName + jobKey while the first is still running', async () => {
    const registry = new JobRegistry();
    // Block the first launch inside its tasklet so it stays STARTED.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register({
      id: 'concurrent-same-params',
      steps: {
        s1: {
          kind: 'tasklet',
          id: 's1',
          tasklet: {
            kind: RefKind.BuilderLambda,
            fn: async () => {
              await blocked;
              return 'ok';
            },
          },
          listeners: [],
        },
      },
      startStepId: 's1',
      transitions: [],
      listeners: [],
      restartable: false,
      allowDuplicateInstances: false,
    });
    const { launcher } = buildLauncher(registry);

    // Kick off launch #1 but don't await — it will block on the tasklet.
    const first = launcher.launch('concurrent-same-params', { x: 1 });

    // Give the event loop a few microtask ticks so launch #1 has created
    // its JobExecution (status STARTED) before launch #2 begins.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Launch #2 with the same jobKey must throw.
    await expect(launcher.launch('concurrent-same-params', { x: 1 })).rejects.toBeInstanceOf(
      JobExecutionAlreadyRunningError,
    );

    try {
      await launcher.launch('concurrent-same-params', { x: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(JobExecutionAlreadyRunningError);
      expect((err as JobExecutionAlreadyRunningError).code).toBe('JOB_EXECUTION_ALREADY_RUNNING');
      expect((err as JobExecutionAlreadyRunningError).details).toEqual({
        jobInstanceId: expect.any(String) as string,
      });
    }

    // Release the first launch so the test can complete cleanly.
    release();
    await first;
  });

  it('allows concurrent launches of the same jobName with different params (different jobKey)', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('concurrent-different-params'));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('concurrent-different-params', { x: 1 });
    const exec2 = await launcher.launch('concurrent-different-params', { x: 2 });

    // Different params → different canonical jobKey → different JobInstance.
    expect(exec1.jobInstanceId).not.toBe(exec2.jobInstanceId);
    // Both reached COMPLETED.
    expect(exec1.status).toBe(JobStatus.COMPLETED);
    expect(exec2.status).toBe(JobStatus.COMPLETED);
  });

  it('allows a relaunch of the same jobName + jobKey after the first execution COMPLETED', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('concurrent-after-complete'));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('concurrent-after-complete', { x: 1 });
    expect(exec1.status).toBe(JobStatus.COMPLETED);

    // After COMPLETED, the previous execution is no longer in STARTING/STARTED,
    // so a fresh launch with the same jobKey is allowed.
    const exec2 = await launcher.launch('concurrent-after-complete', { x: 1 });
    expect(exec2.status).toBe(JobStatus.COMPLETED);
    // Same JobInstance (idempotent on canonical key), but a new JobExecution.
    expect(exec2.jobInstanceId).toBe(exec1.jobInstanceId);
    expect(exec2.id).not.toBe(exec1.id);
  });

  it('allows a relaunch of the same jobName + jobKey after the first execution FAILED', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('concurrent-after-fail', { restartable: true, throwOnRun: true }));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('concurrent-after-fail', { x: 1 });
    expect(exec1.status).toBe(JobStatus.FAILED);

    // After FAILED, the previous execution is no longer in STARTING/STARTED,
    // so a fresh launch with the same jobKey is allowed.
    const exec2 = await launcher.launch('concurrent-after-fail', { x: 1 });
    expect(exec2.status).toBe(JobStatus.FAILED);
    expect(exec2.jobInstanceId).toBe(exec1.jobInstanceId);
    expect(exec2.id).not.toBe(exec1.id);
  });
});
