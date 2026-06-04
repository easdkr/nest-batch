/**
 * Task 48 — Minimal end-to-end smoke test against live PostgreSQL.
 *
 * The full 10-scenario suite (apps/demo/tests/e2e/import-products.e2e.spec.ts)
 * exercises the demo's import-products job end-to-end. It requires a
 * `CsvProductReader` instance to be constructed with a file path at
 * chunk-step time — the current `ImportProductsJob.build()` static
 * factory uses `RefKind.ProviderToken` which the library's chunk
 * executor does not yet resolve, so the demo's import job cannot be
 * launched through `JobLauncher.launch()` without a runtime file-path
 * refactor.
 *
 * This minimal suite proves the core library pipeline works against
 * the real PostgreSQL backend: a 1-step tasklet job is registered,
 * launched, and its execution state is persisted and queryable.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { MikroORM, type EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import {
  BatchBuilder,
  DefinitionCompiler,
  FlowEvaluator,
  JobExecutor,
  JobLauncher,
  JobRegistry,
  JobStatus,
  NestBatchModule,
  StepStatus,
  RefKind,
  type JobBuilderConfig,
  type StepDefinition,
} from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  JobExecutionEntity,
  JobInstanceEntity,
  MikroORMJobRepository,
  MikroORMTransactionManager,
  StepExecutionEntity,
} from '@nest-batch/mikro-orm';
import { ProductEntity } from '../../src/entities/product.entity';

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
};

describe('Task 48 — Library × PostgreSQL integration (live DB)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let moduleRef: TestingModule;
  let launcher: JobLauncher;
  let registry: JobRegistry;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      ...PG_CONFIG,
      entities: [...BATCH_META_ENTITIES, ProductEntity],
    });
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  beforeEach(async () => {
    // The forked EM is bound to the PostgreSqlDriver, so the runtime
    // value IS a SqlEntityManager — we cast at the test boundary.
    const forkedEm = orm.em.fork() as unknown as SqlEntityManager;
    await forkedEm.execute(`
      TRUNCATE TABLE product,
                       batch_step_execution_context,
                       batch_job_execution_context,
                       batch_step_execution,
                       batch_job_execution_params,
                       batch_job_execution,
                       batch_job_instance
      RESTART IDENTITY CASCADE
    `);

    moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();
    await moduleRef.init();
    registry = moduleRef.get(JobRegistry);

    const repository = new MikroORMJobRepository(forkedEm);
    const transactionManager = new MikroORMTransactionManager(forkedEm);
    const flowEvaluator = new FlowEvaluator();
    const jobExecutor = new JobExecutor(
      repository,
      transactionManager,
      new (require('@nest-batch/core').TaskletStepExecutor)(),
      new (require('@nest-batch/core').ChunkStepExecutor)(),
      new (require('@nest-batch/core').ListenerInvoker)(),
      flowEvaluator,
    );
    launcher = new JobLauncher(registry, repository, jobExecutor);
    em = forkedEm;
  });

  test('1. Library + PostgreSQL: 1-step tasklet job runs to COMPLETED and persists execution state', async () => {
    // Register a trivial 1-step job via the builder API
    const jobConfig: JobBuilderConfig = {
      id: 'smoke-tasklet',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 'noop',
      steps: [
        {
          kind: 'tasklet',
          id: 'noop',
          tasklet: {
            kind: RefKind.BuilderLambda,
            fn: () => ({ execute: async () => 'ok' }),
          },
          listeners: [],
        } satisfies StepDefinition,
      ],
      transitions: [],
      listeners: [],
    };
    const compiler = moduleRef.get(DefinitionCompiler);
    const def = compiler.compileFromBuilderConfig(jobConfig);
    registry.register(def);

    const execution = await launcher.launch('smoke-tasklet', { x: 1 });
    expect(execution.status).toBe(JobStatus.COMPLETED);

    // Verify persistence: 1 JobInstance + 1 JobExecution + 1 StepExecution in DB
    const instanceCount = await em.count(JobInstanceEntity, {});
    const execCount = await em.count(JobExecutionEntity, {});
    const stepCount = await em.count(StepExecutionEntity, {});
    expect(instanceCount).toBe(1);
    expect(execCount).toBe(1);
    expect(stepCount).toBe(1);

    // Step execution should be COMPLETED
    const steps = await em.find(StepExecutionEntity, {});
    expect(steps[0]?.status).toBe(StepStatus.COMPLETED);
  }, 15000);
});
