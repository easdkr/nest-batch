import { describe, expect, it } from 'vitest';

import { RefKind, type JobDefinition } from '../../src/core/ir';
import { InvalidJobOperationError } from '../../src/core/errors';
import { JobStatus } from '../../src/core/status';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { JobExecutor } from '../../src/execution/job-executor';
import { JobExplorer } from '../../src/execution/job-explorer';
import { JobLauncher } from '../../src/execution/job-launcher';
import { JobOperator } from '../../src/execution/job-operator';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { JobRegistry } from '../../src/registry/job-registry';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';

function makeTaskletJob(id: string, restartable = false): JobDefinition {
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
    restartable,
    allowDuplicateInstances: false,
  };
}

function buildOperator(registry: JobRegistry): {
  repository: InMemoryJobRepository;
  launcher: JobLauncher;
  explorer: JobExplorer;
  operator: JobOperator;
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
  const explorer = new JobExplorer(registry, repository);
  const operator = new JobOperator(explorer, registry, repository, launcher);
  return { repository, launcher, explorer, operator };
}

describe('JobOperator', () => {
  it('lists jobs, instances, executions, and execution details', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('ops-job'));
    const { launcher, operator } = buildOperator(registry);

    const execution = await launcher.launch('ops-job', { batch: 1 });

    expect(operator.listJobs().map((job) => job.id)).toEqual(['ops-job']);
    expect(await operator.listJobInstances({ jobName: 'ops-job' })).toHaveLength(1);
    expect(await operator.listJobExecutions({ status: JobStatus.COMPLETED })).toHaveLength(1);

    const details = await operator.getJobExecutionDetails(execution.id);
    expect(details.jobExecution.id).toBe(execution.id);
    expect(details.jobInstance.jobName).toBe('ops-job');
    expect(details.stepExecutions).toHaveLength(1);
    expect(details.jobContext).toEqual({ data: null, version: 0 });
    expect(details.stepContexts).toHaveLength(1);
  });

  it('stops an active execution', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('stop-job'));
    const { repository, operator } = buildOperator(registry);

    const execution = await repository.createExecutionAtomic('stop-job', 'manual', {});
    const stopped = await operator.stop(execution.id);

    expect(stopped.jobExecution.status).toBe(JobStatus.STOPPED);
    expect(stopped.jobExecution.exitCode).toBe('STOPPED');
    expect(stopped.jobExecution.endTime).toBeInstanceOf(Date);
  });

  it('abandons a failed execution', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('abandon-job'));
    const { repository, operator } = buildOperator(registry);

    const execution = await repository.createExecutionAtomic('abandon-job', 'manual', {});
    await repository.updateJobExecution(execution.id, {
      status: JobStatus.FAILED,
      endTime: new Date(),
      exitCode: 'FAILED',
    });

    const abandoned = await operator.abandon(execution.id);

    expect(abandoned.jobExecution.status).toBe(JobStatus.ABANDONED);
    expect(abandoned.jobExecution.exitCode).toBe('ABANDONED');
  });

  it('restarts a failed execution through the launcher run path', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('restart-job', true));
    const { repository, operator } = buildOperator(registry);

    const execution = await repository.createExecutionAtomic('restart-job', 'manual', {});
    await repository.updateJobExecution(execution.id, {
      status: JobStatus.FAILED,
      endTime: new Date(),
      exitCode: 'FAILED',
      exitMessage: 'planned failure',
    });

    const restarted = await operator.restart(execution.id);

    expect(restarted.jobExecution.id).toBe(execution.id);
    expect(restarted.jobExecution.status).toBe(JobStatus.COMPLETED);
    expect(restarted.stepExecutions).toHaveLength(1);
  });

  it('rejects restart for executions that are not restart candidates', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('completed-job', true));
    const { launcher, operator } = buildOperator(registry);

    const execution = await launcher.launch('completed-job', {});

    await expect(operator.restart(execution.id)).rejects.toBeInstanceOf(
      InvalidJobOperationError,
    );
  });

  it('starts a new instance by adding an operator run id', async () => {
    const registry = new JobRegistry();
    registry.register(makeTaskletJob('next-job'));
    const { operator } = buildOperator(registry);

    const first = await operator.startNextInstance('next-job', { tenantId: 'a' });
    const second = await operator.startNextInstance('next-job', { tenantId: 'a' });

    expect(first.status).toBe(JobStatus.COMPLETED);
    expect(second.status).toBe(JobStatus.COMPLETED);
    expect(first.jobInstanceId).not.toBe(second.jobInstanceId);
  });
});
