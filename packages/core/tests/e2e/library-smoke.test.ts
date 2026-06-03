import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { NestBatchModule } from '../../src/module/nest-batch.module';
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
      imports: [NestBatchModule.forRoot()],
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
      imports: [NestBatchModule.forRoot()],
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
      imports: [NestBatchModule.forRoot()],
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
