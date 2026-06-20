import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';

import { Jobable, Stepable, Tasklet } from '../../src/decorators';
import { JobRegistry } from '../../src/registry/job-registry';
import { BatchExplorer } from '../../src/explorer/batch-explorer';
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import { BatchWorkerRunner } from '../../src/execution/batch-worker-runner';
import { JobExplorer } from '../../src/execution/job-explorer';
import { JobOperator } from '../../src/execution/job-operator';
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
import { NestBatchModule, type NestBatchModuleAsyncOptions } from '../../src/module/nest-batch.module';
import { InProcessAdapter } from '../../src/adapters/in-process.adapter';
import { BatchScheduleRegistry } from '../../src/module/batch-schedule-registry';
import type { BatchAdapter, BatchAdaptersConfig } from '../../src/module/adapter';
import {
  BATCH_SCHEDULE_REGISTRY,
  EXECUTION_STRATEGY,
  JOB_REPOSITORY_TOKEN,
  MODULE_OPTIONS_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '../../src/module/tokens';

// ---------------------------------------------------------------------------
// Stub adapter — minimum surface that satisfies `BatchAdaptersConfig` for
// the suite's "module boots" tests. The module field is an empty class
// (Nest requires *some* class to identify the module), the globalProviders
// are the canonical symbol-token bindings the suite exercises
// (JOB_REPOSITORY_TOKEN / TRANSACTION_MANAGER_TOKEN / EXECUTION_STRATEGY).
// ---------------------------------------------------------------------------

class StubModule {}

class StubRepository extends JobRepository {
  readonly marker = 'stub-repo' as const;
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

class StubTransactionManager extends TransactionManager {
  readonly marker = 'stub-tx' as const;
  async withTransaction<T>(fn: (ctx: { isActive: true; id: string }) => Promise<T>): Promise<T> {
    return fn({ isActive: true, id: 'stub-tx' });
  }
}

const stubAdapter: BatchAdapter = {
  name: 'stub',
  module: { module: StubModule, providers: [], exports: [] },
  globalProviders: [
    StubRepository,
    StubTransactionManager,
    { provide: JOB_REPOSITORY_TOKEN, useClass: StubRepository },
    { provide: TRANSACTION_MANAGER_TOKEN, useClass: StubTransactionManager },
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
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal tasklet job used to verify the explorer → compiler → registry
 * wiring fires on application bootstrap. One @Stepable + @Tasklet method,
 * no listeners, no transitions — the simplest possible valid job.
 */
@Jobable({ id: 'test-job' })
class TestJobClass {
  @Stepable({ id: 's1' })
  @Tasklet()
  async s1(): Promise<void> {
    return;
  }
}

/**
 * A second job used to verify multi-class discovery through the module.
 * Different id from `TestJobClass` so the registry is exercised.
 */
@Jobable({ id: 'other-test-job', restartable: true })
class OtherJobClass {
  @Stepable({ id: 'o1' })
  @Tasklet()
  async run(): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// forRoot — boot
// ---------------------------------------------------------------------------

describe('NestBatchModule.forRoot()', () => {
  it('compiles a test module that imports NestBatchModule.forRoot()', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.init();
    await moduleRef.close();
  });

  it('exposes JobRegistry as an injectable (resolves from the test module)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry).toBeInstanceOf(JobRegistry);
    // No @Jobable providers were registered → registry is empty.
    expect(registry.getAll()).toEqual([]);

    await moduleRef.close();
  });

  it('exposes explorer, compiler, and operator providers as injectables too', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
    }).compile();

    await moduleRef.init();
    expect(moduleRef.get(BatchExplorer)).toBeInstanceOf(BatchExplorer);
    expect(moduleRef.get(DefinitionCompiler)).toBeInstanceOf(DefinitionCompiler);
    expect(moduleRef.get(JobExplorer)).toBeInstanceOf(JobExplorer);
    expect(moduleRef.get(JobOperator)).toBeInstanceOf(JobOperator);
    expect(moduleRef.get(BatchWorkerRunner)).toBeInstanceOf(BatchWorkerRunner);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// Explorer → Registry wiring via OnApplicationBootstrap
// ---------------------------------------------------------------------------

describe('NestBatchModule — explorer → registry wiring', () => {
  it('discovers a @Jobable test class and registers it on application bootstrap', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init(); // triggers BatchExplorer.onModuleInit + BatchBootstrapper.onApplicationBootstrap
    const registry = moduleRef.get(JobRegistry);

    expect(registry.has('test-job')).toBe(true);

    const def = registry.get('test-job');
    expect(def.id).toBe('test-job');
    expect(Object.keys(def.steps)).toEqual(['s1']);
    expect(def.startStepId).toBe('s1');
    expect(def.transitions).toEqual([]);
    expect(def.listeners).toEqual([]);

    const step = def.steps['s1']!;
    expect(step.kind).toBe('tasklet');
    expect(step.id).toBe('s1');
    if (step.kind === 'tasklet') {
      // Instance was supplied → compiler emitted a bound BuilderLambda.
      expect(step.tasklet.kind).toBe('builder-lambda');
      expect(typeof step.tasklet.fn).toBe('function');
    }

    await moduleRef.close();
  });

  it('registers multiple @Jobable classes from the same module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [TestJobClass, OtherJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);

    expect(registry.has('test-job')).toBe(true);
    expect(registry.has('other-test-job')).toBe(true);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get('other-test-job').restartable).toBe(true);

    await moduleRef.close();
  });

  it('leaves the registry empty when no @Jobable providers exist', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [
        // A plain, non-@Jobable class — must not register.
        class NotAJob {
          doStuff(): void {}
        },
      ],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.getAll()).toEqual([]);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// forRootAsync — boot with a mock factory
// ---------------------------------------------------------------------------

describe('NestBatchModule.forRootAsync()', () => {
  it('boots with a synchronous mock factory', async () => {
    const asyncOptions: NestBatchModuleAsyncOptions = {
      useFactory: () => stubAdapters,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('boots with an async (Promise-returning) mock factory', async () => {
    const asyncOptions: NestBatchModuleAsyncOptions = {
      useFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return stubAdapters;
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('boots with a factory that injects another provider', async () => {
    const CONFIG_TOKEN = 'BATCH_FACTORY_CONFIG';
    @Module({
      providers: [{ provide: CONFIG_TOKEN, useValue: stubAdapters }],
      exports: [CONFIG_TOKEN],
    })
    class ConfigModule {}

    const asyncOptions: NestBatchModuleAsyncOptions = {
      imports: [ConfigModule],
      inject: [CONFIG_TOKEN],
      useFactory: (config: unknown) => config as BatchAdaptersConfig,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('exposes JobRegistry as injectable from a forRootAsync module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestBatchModule.forRootAsync({
          useFactory: () => stubAdapters,
        }),
      ],
    }).compile();

    await moduleRef.init();
    expect(moduleRef.get(JobRegistry)).toBeInstanceOf(JobRegistry);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// Module shape / API sanity
// ---------------------------------------------------------------------------

describe('NestBatchModule — surface', () => {
  it('forRoot({ adapters }) exposes the resolved BatchAdaptersConfig through MODULE_OPTIONS_TOKEN', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
    }).compile();

    await moduleRef.init();
    const stored = moduleRef.get<BatchAdaptersConfig>(MODULE_OPTIONS_TOKEN);
    expect(stored).toBe(stubAdapters);
    expect(stored.persistence.name).toBe('stub');
    expect(stored.transport.name).toBe('in-process');

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// JOB_REPOSITORY_TOKEN / TRANSACTION_MANAGER_TOKEN aliasing — the canonical
// symbol tokens must resolve regardless of whether the host binds the
// repository to a class token or the symbol.
// ---------------------------------------------------------------------------

/**
 * Concrete JobRepository used as a class-token override. The methods are
 * stubs because the module is only asked to resolve the DI graph; no
 * batch code path actually runs.
 */
class AliasFakeJobRepository extends JobRepository {
  readonly marker = 'alias-fake-repo' as const;
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

class AliasFakeTransactionManager extends TransactionManager {
  readonly marker = 'alias-fake-tx' as const;
  async withTransaction<T>(fn: (ctx: { isActive: true; id: string }) => Promise<T>): Promise<T> {
    return fn({ isActive: true, id: 'alias-fake-tx' });
  }
}

/**
 * Stub adapter carrying the alias-only JobRepository binding. Mirrors the
 * shape a real persistence adapter would expose — `globalProviders` with
 * the canonical symbol binding. The transport slot is the in-process
 * adapter because the suite does not exercise transport resolution here.
 */
const aliasAdapter: BatchAdapter = {
  name: 'alias-stub',
  module: { module: class AliasModule {}, providers: [], exports: [] },
  globalProviders: [
    { provide: JOB_REPOSITORY_TOKEN, useClass: AliasFakeJobRepository },
    {
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: AliasFakeTransactionManager,
    },
  ],
};

const aliasAdapters: BatchAdaptersConfig = {
  persistence: aliasAdapter,
  transport: InProcessAdapter.forRoot(),
};

describe('NestBatchModule — JOB_REPOSITORY_TOKEN aliasing (Bug #2 fix)', () => {
  it('forRoot(): the persistence adapter binds the repository to JOB_REPOSITORY_TOKEN and the symbol resolves to the same instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: aliasAdapters })],
    }).compile();

    await moduleRef.init();
    const bySymbol = moduleRef.get(JOB_REPOSITORY_TOKEN);

    expect(bySymbol).toBeInstanceOf(AliasFakeJobRepository);

    await moduleRef.close();
  });

  it('forRootAsync(): the persistence adapter binds the repository to JOB_REPOSITORY_TOKEN and the symbol resolves to the same instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestBatchModule.forRootAsync({
          useFactory: () => aliasAdapters,
        }),
      ],
    }).compile();

    await moduleRef.init();
    const bySymbol = moduleRef.get(JOB_REPOSITORY_TOKEN);

    expect(bySymbol).toBeInstanceOf(AliasFakeJobRepository);

    await moduleRef.close();
  });

  it('forRoot(): adapter binds directly to JOB_REPOSITORY_TOKEN; no duplicate provider is registered (idempotent)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ adapters: aliasAdapters })],
    }).compile();

    await moduleRef.init();
    const bySymbol = moduleRef.get(JOB_REPOSITORY_TOKEN);
    expect(bySymbol).toBeInstanceOf(AliasFakeJobRepository);

    await moduleRef.close();
  });

  it('forRootAsync(): adapter binds directly to JOB_REPOSITORY_TOKEN; no duplicate provider is registered (idempotent)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestBatchModule.forRootAsync({
          useFactory: () => aliasAdapters,
        }),
      ],
    }).compile();

    await moduleRef.init();
    const bySymbol = moduleRef.get(JOB_REPOSITORY_TOKEN);
    expect(bySymbol).toBeInstanceOf(AliasFakeJobRepository);

    await moduleRef.close();
  });
});
