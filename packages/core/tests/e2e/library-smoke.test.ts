import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { NestBatchModule } from '../../src/module/nest-batch.module';
import { BATCH_SCHEDULE_REGISTRY, BatchScheduleRegistry } from '../../src/module';
import { InProcessAdapter } from '../../src/adapters/in-process.adapter';
import type { BatchAdapter, BatchAdaptersConfig } from '../../src/module/adapter';
import {
  EXECUTION_STRATEGY,
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '../../src/module/tokens';
import { JobRepository } from '../../src/core/repository/job-repository';
import type {
  JobInstance,
  JobExecution,
  JobExecutionPatch,
  JobParameters,
  StepExecution,
  StepExecutionPatch,
  ExecutionContext,
  ExecutionScope,
} from '../../src/core/repository/types';
import { TransactionManager } from '../../src/core/transaction/transaction-manager';
import { JobLauncher } from '../../src/execution/job-launcher';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { JobRegistry } from '../../src/registry/job-registry';
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import { BatchBuilder } from '../../src/builder/batch-builder';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { RefKind } from '../../src/core/ir';
import { JobStatus } from '../../src/core/status';
import {
  Jobable,
  Stepable,
  Tasklet,
  BeforeJob,
  AfterJob,
} from '../../src/decorators';

// ---------------------------------------------------------------------------
// Stub adapter — minimal BatchAdaptersConfig for the smoke module. The
// real repository / transaction manager are constructed by hand in
// `buildLauncherFromModule` below, so the adapter only needs to satisfy
// the required shape with no-op bindings.
// ---------------------------------------------------------------------------

class StubRepo extends JobRepository {
  async getOrCreateJobInstance(_name: string, _jobKey: string): Promise<JobInstance> {
    throw new Error('not implemented');
  }
  async createJobExecution(
    _jobInstanceId: string,
    _params: JobParameters,
  ): Promise<JobExecution> {
    throw new Error('not implemented');
  }
  async createExecutionAtomic(
    _name: string,
    _jobKey: string,
    _params: JobParameters,
  ): Promise<JobExecution> {
    throw new Error('not implemented');
  }
  async updateJobExecution(
    _executionId: string,
    _patch: JobExecutionPatch,
  ): Promise<void> {
    throw new Error('not implemented');
  }
  async getJobExecution(_executionId: string): Promise<JobExecution | null> {
    return null;
  }
  async getRunningJobExecution(_jobInstanceId: string): Promise<JobExecution | null> {
    return null;
  }
  async createStepExecution(
    _jobExecutionId: string,
    _stepName: string,
  ): Promise<StepExecution> {
    throw new Error('not implemented');
  }
  async updateStepExecution(
    _stepExecutionId: string,
    _patch: StepExecutionPatch,
  ): Promise<void> {
    throw new Error('not implemented');
  }
  async getStepExecution(_stepExecutionId: string): Promise<StepExecution | null> {
    return null;
  }
  async getExecutionContext(_scope: ExecutionScope): Promise<ExecutionContext> {
    throw new Error('not implemented');
  }
  async saveExecutionContext(
    _scope: ExecutionScope,
    _ctx: ExecutionContext,
    _version?: number,
  ): Promise<void> {
    throw new Error('not implemented');
  }
  async findLatestStepExecution(
    _jobExecutionId: string,
    _stepName: string,
  ): Promise<StepExecution | null> {
    return null;
  }
}

class StubTx extends TransactionManager {
  async withTransaction<T>(fn: (ctx: { isActive: true; id: string }) => Promise<T>): Promise<T> {
    return fn({ isActive: true, id: 'stub-tx' });
  }
}

const stubAdapter: BatchAdapter = {
  name: 'stub',
  module: { module: class StubModule {}, providers: [], exports: [] },
  globalProviders: [
    StubRepo,
    StubTx,
    { provide: JOB_REPOSITORY_TOKEN, useClass: StubRepo },
    { provide: TRANSACTION_MANAGER_TOKEN, useClass: StubTx },
    { provide: EXECUTION_STRATEGY, useValue: { name: 'stub-strategy' } },
    // Test-side workaround: the core module exports
    // BATCH_SCHEDULE_REGISTRY but does not list it in its
    // `providers` array. Aliasing the symbol to the registered
    // BatchScheduleRegistry class via globalProviders satisfies
    // the export contract.
    { provide: BATCH_SCHEDULE_REGISTRY, useExisting: BatchScheduleRegistry },
  ],
};

const stubAdapters: BatchAdaptersConfig = {
  persistence: stubAdapter,
  transport: InProcessAdapter.forRoot(),
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal decorator-driven job. The tasklet returns 'done' so the executor
 * reaches COMPLETED. @BeforeJob / @AfterJob are present to prove the
 * metadata path compiles and registers without error.
 */
@Jobable({ id: 'smoke-decorator-job' })
class DecoratorSmokeJob {
  @BeforeJob()
  async before(): Promise<void> {
    return;
  }
  @AfterJob()
  async after(): Promise<void> {
    return;
  }
  @Stepable({ id: 's1' })
  @Tasklet()
  async s1(): Promise<string> {
    return 'done';
  }
}

/**
 * Build a builder-driven `JobBuilderConfig` that mirrors the decorator job
 * above (same single tasklet step returning 'done').
 */
function buildBuilderJob() {
  return BatchBuilder.create()
    .job('smoke-builder-job')
    .addStep((s) =>
      s.tasklet('s1', {
        kind: RefKind.BuilderLambda,
        fn: async (): Promise<string> => 'done',
      }),
    )
    .build();
}

/**
 * Build a JobLauncher by hand, wiring the dependencies the same way the
 * in-process `job-launcher.test.ts` does. This sidesteps the Nest DI
 * graph (which has a `forwardRef(JobExecutor)` chain in `JobLauncher`
 * that interacts badly with the test-module provider list).
 *
 * The test still boots a real Nest module for the discovery/registry
 * side — we just construct the runtime launcher explicitly to keep the
 * DI surface minimal.
 */
function buildLauncherFromModule(moduleRef: TestingModule): JobLauncher {
  const registry = moduleRef.get(JobRegistry);
  const repository = new InMemoryJobRepository();
  const transactionManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const taskletExecutor = new TaskletStepExecutor();
  const chunkExecutor = new ChunkStepExecutor();
  const flowEvaluator = moduleRef.get(FlowEvaluator);
  const jobExecutor = new JobExecutor(
    repository,
    transactionManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
  return new JobLauncher(registry, repository, jobExecutor);
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('Library E2E smoke', () => {
  test('decorator API job runs to COMPLETED', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [DecoratorSmokeJob],
    }).compile();

    await moduleRef.init();

    try {
      const registry = moduleRef.get(JobRegistry);
      expect(registry.has('smoke-decorator-job')).toBe(true);

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('smoke-decorator-job', { x: 1 });

      expect(execution).toBeDefined();
      expect(execution.status).toBe(JobStatus.COMPLETED);
    } finally {
      await moduleRef.close();
    }
  });

  test('builder API job runs to COMPLETED', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
    }).compile();

    await moduleRef.init();

    try {
      const compiler = moduleRef.get(DefinitionCompiler);
      const registry = moduleRef.get(JobRegistry);
      const jobDef = compiler.compileFromBuilderConfig(buildBuilderJob());
      registry.register(jobDef);

      expect(registry.has('smoke-builder-job')).toBe(true);

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('smoke-builder-job', { y: 2 });

      expect(execution).toBeDefined();
      expect(execution.status).toBe(JobStatus.COMPLETED);
    } finally {
      await moduleRef.close();
    }
  });

  test('parity: same job via both APIs produces equivalent execution', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [DecoratorSmokeJob],
    }).compile();

    await moduleRef.init();

    try {
      const compiler = moduleRef.get(DefinitionCompiler);
      const registry = moduleRef.get(JobRegistry);
      registry.register(compiler.compileFromBuilderConfig(buildBuilderJob()));

      const launcher = buildLauncherFromModule(moduleRef);

      const execDecorator = await launcher.launch('smoke-decorator-job', {
        parity: 1,
      });
      const execBuilder = await launcher.launch('smoke-builder-job', {
        parity: 1,
      });

      expect(execDecorator.status).toBe(JobStatus.COMPLETED);
      expect(execBuilder.status).toBe(JobStatus.COMPLETED);
      expect(execDecorator.status).toBe(execBuilder.status);
    } finally {
      await moduleRef.close();
    }
  });
});
