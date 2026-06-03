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
import { JobNotFoundError } from '../../src/core/errors';
import { JobStatus } from '../../src/core/status';

/**
 * Build a minimal valid one-tasklet JobDefinition. The tasklet just
 * returns the string 'ok' so the executor reaches COMPLETED.
 */
function makeTaskletJob(
  id: string,
  opts: { allowDuplicateInstances?: boolean } = {},
): JobDefinition {
  return {
    id,
    steps: {
      s1: {
        kind: 'tasklet',
        id: 's1',
        tasklet: { kind: RefKind.BuilderLambda, fn: async () => 'ok' },
        listeners: [],
      },
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: opts.allowDuplicateInstances ?? false,
  };
}

/**
 * Wire the full launcher dependency graph by hand (no Nest Test module
 * needed — every dependency is constructible directly and the launcher
 * is a leaf consumer).
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

describe('JobLauncher', () => {
  it('launch(unknown jobId) throws JobNotFoundError with code JOB_NOT_FOUND', async () => {
    const registry = new JobRegistry();
    const { launcher } = buildLauncher(registry);

    await expect(launcher.launch('does-not-exist', { foo: 1 })).rejects.toBeInstanceOf(
      JobNotFoundError,
    );

    try {
      await launcher.launch('does-not-exist', { foo: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(JobNotFoundError);
      expect((err as JobNotFoundError).code).toBe('JOB_NOT_FOUND');
      expect((err as JobNotFoundError).details).toEqual({ jobId: 'does-not-exist' });
    }
  });

  it('same params twice → same JobInstance.id but different JobExecution.id', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('job-same-params'));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('job-same-params', { x: 1, y: 'a' });
    const exec2 = await launcher.launch('job-same-params', { x: 1, y: 'a' });

    // Same JobInstance (idempotent on canonical key)
    expect(exec1.jobInstanceId).toBe(exec2.jobInstanceId);
    // Different JobExecution
    expect(exec1.id).not.toBe(exec2.id);
    // Both reached COMPLETED
    expect(exec1.status).toBe(JobStatus.COMPLETED);
    expect(exec2.status).toBe(JobStatus.COMPLETED);
  });

  it('different param key order but same values → same JobInstance.id', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('job-canonical-order'));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('job-canonical-order', { a: 1, b: 2, c: 'x' });
    const exec2 = await launcher.launch('job-canonical-order', { c: 'x', a: 1, b: 2 });
    const exec3 = await launcher.launch('job-canonical-order', { b: 2, c: 'x', a: 1 });

    expect(exec1.jobInstanceId).toBe(exec2.jobInstanceId);
    expect(exec2.jobInstanceId).toBe(exec3.jobInstanceId);
  });

  it('nested param key order is also canonicalized (recursive sort)', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('job-nested-canonical'));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('job-nested-canonical', { outer: { z: 3, a: 1, m: 2 } });
    const exec2 = await launcher.launch('job-nested-canonical', { outer: { a: 1, m: 2, z: 3 } });

    expect(exec1.jobInstanceId).toBe(exec2.jobInstanceId);
  });

  it('allowDuplicateInstances: true → different JobInstance.id per launch', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('job-dup-instances', { allowDuplicateInstances: true }));
    const { launcher } = buildLauncher(registry);

    const exec1 = await launcher.launch('job-dup-instances', { x: 1 });
    const exec2 = await launcher.launch('job-dup-instances', { x: 1 });
    const exec3 = await launcher.launch('job-dup-instances', { x: 1 });

    // Each launch creates a fresh JobInstance (unique nonce in jobKey)
    expect(exec1.jobInstanceId).not.toBe(exec2.jobInstanceId);
    expect(exec2.jobInstanceId).not.toBe(exec3.jobInstanceId);
    expect(exec1.jobInstanceId).not.toBe(exec3.jobInstanceId);
    // But every JobExecution is still distinct from its instance id
    expect(exec1.id).not.toBe(exec1.jobInstanceId);
    expect(exec2.id).not.toBe(exec2.jobInstanceId);
  });

  it('launch returns a non-undefined JobExecution with status COMPLETED', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('job-returns'));
    const { launcher } = buildLauncher(registry);

    const exec = await launcher.launch('job-returns', { x: 1 });

    expect(exec).toBeDefined();
    expect(typeof exec.id).toBe('string');
    expect(exec.id.length).toBeGreaterThan(0);
    expect(exec.status).toBe(JobStatus.COMPLETED);
    expect(exec.endTime).toBeInstanceOf(Date);
    // Params roundtrip into the execution
    expect(exec.params).toEqual({ x: 1 });
  });
});
