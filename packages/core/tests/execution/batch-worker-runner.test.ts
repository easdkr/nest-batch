import { describe, expect, it } from 'vitest';

import { RefKind, type JobDefinition } from '../../src/core/ir';
import { JobStatus } from '../../src/core/status';
import { BatchWorkerRunner, parseBatchWorkerArgs } from '../../src/execution/batch-worker-runner';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { JobExecutor } from '../../src/execution/job-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { JobRegistry } from '../../src/registry/job-registry';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';

function makeJob(id: string, calls: string[]): JobDefinition {
  return {
    id,
    steps: {
      s1: {
        kind: 'tasklet',
        id: 's1',
        tasklet: {
          kind: RefKind.BuilderLambda,
          fn: () => ({
            execute: async () => {
              calls.push(id);
              return 'ok';
            },
          }),
        },
        listeners: [],
      },
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: true,
    allowDuplicateInstances: false,
  };
}

function buildRunner(registry: JobRegistry): {
  repository: InMemoryJobRepository;
  runner: BatchWorkerRunner;
} {
  const repository = new InMemoryJobRepository();
  const executor = new JobExecutor(
    repository,
    new InMemoryTransactionManager(),
    new TaskletStepExecutor(),
    new ChunkStepExecutor(),
    new ListenerInvoker(),
    new FlowEvaluator(),
  );
  return {
    repository,
    runner: new BatchWorkerRunner(registry, repository, executor),
  };
}

describe('BatchWorkerRunner', () => {
  it('runs an existing job execution by id', async () => {
    const registry = new JobRegistry();
    const calls: string[] = [];
    registry.register(makeJob('worker-existing', calls));
    const { repository, runner } = buildRunner(registry);
    const execution = await repository.createExecutionAtomic('worker-existing', 'manual', {});

    const result = await runner.run({ jobExecutionId: execution.id });

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(result.processExitCode).toBe(0);
    expect(result.jobExecution.id).toBe(execution.id);
    expect(calls).toEqual(['worker-existing']);
  });

  it('creates and runs a job execution from job id and params', async () => {
    const registry = new JobRegistry();
    const calls: string[] = [];
    registry.register(makeJob('worker-new', calls));
    const { runner } = buildRunner(registry);

    const result = await runner.run({ jobId: 'worker-new', params: { tenantId: 'a' } });

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(result.jobExecution.params).toEqual({ tenantId: 'a' });
    expect(calls).toEqual(['worker-new']);
  });

  it('parses batch-worker CLI style args', () => {
    expect(
      parseBatchWorkerArgs([
        'batch-worker',
        '--job-id=nightly',
        '--params-json',
        '{"tenantId":"a"}',
        '--partition-index=1',
        '--partition-count=4',
      ]),
    ).toEqual({
      jobId: 'nightly',
      params: { tenantId: 'a' },
      partitionIndex: 1,
      partitionCount: 4,
    });
  });
});
