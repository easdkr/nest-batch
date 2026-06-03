import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, test, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

import { RefKind, type JobDefinition } from '../../src/core/ir';
import { JobRepository } from '../../src/core/repository/job-repository';
import { JobStatus } from '../../src/core/status';
import { TransactionManager } from '../../src/core/transaction/transaction-manager';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import {
  EXECUTION_STRATEGY,
  type IExecutionStrategy,
  type LaunchResult,
  type ExecutionStrategyContext,
} from '../../src/execution/execution-strategy';
import { JobExecutor } from '../../src/execution/job-executor';
import { JobLauncher } from '../../src/execution/job-launcher';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { JobRegistry } from '../../src/registry/job-registry';
import { UuidIdGenerator } from '../../src/repository/id-generator';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal one-tasklet JobDefinition. The tasklet returns the
 * string 'ok' so the executor reaches COMPLETED.
 */
function makeTaskletJob(id: string): JobDefinition {
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
    allowDuplicateInstances: false,
  };
}

// ---------------------------------------------------------------------------
// Module wiring
// ---------------------------------------------------------------------------

/**
 * Build a Nest testing module that wires the full launcher dependency
 * graph and binds a strategy to the `EXECUTION_STRATEGY` token.
 *
 * Why a Nest module? The launcher's strategy is intended to be
 * injected by token in the GREEN impl (Task 11). Wiring through
 * `Test.createTestingModule` makes the test resilient to the exact
 * constructor shape — Nest resolves whatever the launcher actually
 * declares. For RED the launcher does not declare the strategy at
 * all, so the strategy is bound here but ignored at runtime; that
 * mismatch is what the test asserts.
 */
async function buildModuleWithStrategy(strategy: IExecutionStrategy): Promise<{
  moduleRef: TestingModule;
  launcher: JobLauncher;
  strategy: IExecutionStrategy;
}> {
  // Abstract `JobRepository` and `TransactionManager` need to be
  // aliased to concrete instances for Nest DI to resolve them.
  const repository = new InMemoryJobRepository(new UuidIdGenerator());
  const transactionManager = new InMemoryTransactionManager();
  const moduleRef = await Test.createTestingModule({
    providers: [
      JobRegistry,
      { provide: InMemoryJobRepository, useValue: repository },
      { provide: JobRepository, useValue: repository },
      { provide: InMemoryTransactionManager, useValue: transactionManager },
      { provide: TransactionManager, useValue: transactionManager },
      ListenerInvoker,
      TaskletStepExecutor,
      ChunkStepExecutor,
      FlowEvaluator,
      JobExecutor,
      JobLauncher,
      {
        provide: EXECUTION_STRATEGY,
        useValue: strategy,
      },
    ],
  }).compile();

  return {
    moduleRef,
    launcher: moduleRef.get(JobLauncher),
    strategy: moduleRef.get<IExecutionStrategy>(EXECUTION_STRATEGY),
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe('JobLauncher strategy contract (RED — Task 11 pending)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  // -------------------------------------------------------------------------
  // (a) Default in-process strategy preserves current JobExecutor behavior
  // -------------------------------------------------------------------------

  describe('default in-process strategy preserves current JobExecutor behavior', () => {
    let launchSpy: Mock;
    let strategy: IExecutionStrategy;
    let launcher: JobLauncher;

    beforeEach(async () => {
      launchSpy = vi.fn();
      // The in-process test impl calls the SAME JobExecutor instance
      // the launcher is wired to, so the runtime state (repository,
      // step executions) is shared. Because today's launcher does
      // not delegate to the strategy, this strategy is bound but
      // ignored — the assertion that `launchSpy` was called is the
      // RED signal.
      strategy = {
        name: 'in-process-test',
        launch: async (
          job: JobDefinition,
          params: unknown,
          ctx: ExecutionStrategyContext,
        ): Promise<LaunchResult> => {
          launchSpy(job, params, ctx);
          // Fetch the execution the launcher pre-created, then run
          // the executor exactly the way the current direct path
          // does. The result is a terminal JobExecution; we
          // translate it into the discriminated `LaunchResult`
          // shape the contract requires.
          const executor = moduleRef.get(JobExecutor);
          const repository = moduleRef.get(InMemoryJobRepository);
          const execution = await repository.getJobExecution(ctx.executionId);
          if (!execution) {
            throw new Error(
              `[in-process-test strategy] expected execution ${ctx.executionId} to exist`,
            );
          }
          const finished = await executor.execute(execution, job);
          return { kind: 'completed', status: finished.status };
        },
      };

      const built = await buildModuleWithStrategy(strategy);
      moduleRef = built.moduleRef;
      launcher = built.launcher;
      strategy = built.strategy;
    });

    test('the strategy is invoked with (job, params, ctx) and the job reaches COMPLETED', async () => {
      const registry = moduleRef.get(JobRegistry);
      registry.register(makeTaskletJob('in-process-strategy-job'));

      const execution = await launcher.launch('in-process-strategy-job', { foo: 1 });

      // GREEN signal (will be RED until Task 11 lands):
      //   - the strategy's `launch` was called exactly once
      //   - it received the JobDefinition, the params, and a ctx
      //     object with both string ids populated
      expect(launchSpy).toHaveBeenCalledTimes(1);
      const [receivedJob, receivedParams, receivedCtx] = launchSpy.mock.calls[0]!;
      expect(receivedJob.id).toBe('in-process-strategy-job');
      expect(receivedParams).toEqual({ foo: 1 });
      expect(typeof receivedCtx.executionId).toBe('string');
      expect(receivedCtx.executionId.length).toBeGreaterThan(0);
      expect(receivedCtx.executionId).toBe(execution.id);
      expect(typeof receivedCtx.jobExecutionId).toBe('string');
      expect(receivedCtx.jobExecutionId).toBe(execution.id);

      // The launcher must still return a terminal JobExecution so
      // the controller-facing API (`Promise<JobExecution>`) is
      // preserved. The in-process default reaches the same terminal
      // status the current direct `JobExecutor` path produces.
      expect(execution).toBeDefined();
      expect(execution.status).toBe(JobStatus.COMPLETED);
      expect(execution.endTime).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  // (b) Fake transport strategy receives (job, params, ctx) and the result
  //     is observable to the caller
  // -------------------------------------------------------------------------

  describe('fake transport strategy delegates without running the executor', () => {
    let launchSpy: Mock;
    let strategy: IExecutionStrategy;
    let launcher: JobLauncher;

    beforeEach(async () => {
      launchSpy = vi.fn();
      // Fake transport: record the call, return an `enqueued`
      // result. The GREEN launcher is expected to read the latest
      // persisted JobExecution (still in STARTING since the executor
      // never ran) and return it to the caller unchanged. Today the
      // launcher ignores the strategy and runs the executor to
      // COMPLETED, so the assertions fail (RED).
      strategy = {
        name: 'fake-transport-test',
        launch: async (
          job: JobDefinition,
          params: unknown,
          ctx: ExecutionStrategyContext,
        ): Promise<LaunchResult> => {
          launchSpy(job, params, ctx);
          return { kind: 'enqueued', queueJobId: 'fake-queue-1' };
        },
      };

      const built = await buildModuleWithStrategy(strategy);
      moduleRef = built.moduleRef;
      launcher = built.launcher;
      strategy = built.strategy;
    });

    test('the strategy receives the job, params, and ctx exactly once', async () => {
      const registry = moduleRef.get(JobRegistry);
      registry.register(makeTaskletJob('fake-transport-job'));

      await launcher.launch('fake-transport-job', { file: 'sample.csv' });

      expect(launchSpy).toHaveBeenCalledTimes(1);
      const [receivedJob, receivedParams, receivedCtx] = launchSpy.mock.calls[0]!;
      expect(receivedJob.id).toBe('fake-transport-job');
      expect(receivedParams).toEqual({ file: 'sample.csv' });
      // ctx must be a plain object with both ids populated as
      // strings — the contract spec lists them inline.
      expect(typeof receivedCtx).toBe('object');
      expect(receivedCtx).not.toBeNull();
      expect(typeof receivedCtx.executionId).toBe('string');
      expect(typeof receivedCtx.jobExecutionId).toBe('string');
      expect(receivedCtx.executionId).toBe(receivedCtx.jobExecutionId);
    });

    test('the result is observable to the caller: JobExecution stays in STARTING when strategy enqueues', async () => {
      const registry = moduleRef.get(JobRegistry);
      registry.register(makeTaskletJob('fake-transport-observable-job'));

      const execution = await launcher.launch('fake-transport-observable-job', { x: 1 });

      // RED today: the launcher runs the executor directly, so
      // status reaches COMPLETED. After Task 11, the strategy
      // returns `enqueued` and the launcher stops at the
      // pre-execution STARTING state.
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe(JobStatus.STARTING);

      // The executor was bypassed → no step execution record exists.
      const repository = moduleRef.get(InMemoryJobRepository);
      const latestStep = await repository.findLatestStepExecution(execution.id, 's1');
      expect(latestStep).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Controller-facing API stability: JobLauncher.launch(jobId, params)
  // -------------------------------------------------------------------------

  describe('public API stability: JobLauncher.launch(jobId, params)', () => {
    test('launch is a method on the prototype that accepts (jobId, params?)', () => {
      // Guard for the controller-facing API. The controller supplies
      // a `useValue` stub in its own test, so the real launcher's
      // constructor shape is invisible to it — but the prototype
      // method shape must not change.
      expect(typeof JobLauncher.prototype.launch).toBe('function');
      expect(JobLauncher.prototype.launch.length).toBe(1);
    });
  });
});
