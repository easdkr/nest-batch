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
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import {
  BATCH_SCHEDULE_REGISTRY,
  BatchBuilder,
  BatchScheduleRegistry,
  DefinitionCompiler,
  EXECUTION_STRATEGY,
  FlowEvaluator,
  JobExecutor,
  JobLauncher,
  JobRegistry,
  JobStatus,
  NestBatchModule,
  StepStatus,
  RefKind,
  type BatchAdapter,
  type IExecutionStrategy,
  type JobBuilderConfig,
  type StepDefinition,
} from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  JobExecutionEntity,
  JobInstanceEntity,
  StepExecutionEntity,
} from '@nest-batch/postgresql';
import {
  MikroOrmAdapter,
  MikroORMJobRepository,
  MikroORMTransactionManager,
} from '@nest-batch/mikro-orm';
import { ProductEntity } from '../../src/entities/product.entity';

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
};

function formatPostgresError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join(' | ');
  }
  return err instanceof Error
    ? err.message || err.stack?.split('\n')[0] || err.toString()
    : String(err);
}

/**
 * Build a stub transport `BatchAdapter` for the e2e tests.
 *
 * The real `InProcessAdapter` registers an `InProcessExecutionStrategy`
 * whose constructor needs `JobRepository` (abstract class) injected.
 * Under the new factory API, the persistence adapter only binds the
 * `JOB_REPOSITORY_TOKEN` symbol + the concrete `MikroORMJobRepository`
 * class — it does NOT provide the abstract `JobRepository` token, so
 * the strategy cannot be resolved. The e2e tests here do not actually
 * need a transport strategy (they construct `JobLauncher` manually
 * with a hand-wired `JobExecutor`), so we supply a no-op
 * `EXECUTION_STRATEGY` value provider via `globalProviders` and skip
 * the real adapter entirely.
 *
 * Also includes the `BATCH_SCHEDULE_REGISTRY` symbol binding — T2's
 * `NestBatchModule.forRoot()` exports the symbol but does not
 * register a provider for it, so Nest's `validateExportedProvider`
 * rejects the test module unless the binding is supplied here.
 *
 * Both workarounds can be removed once T2 / T4 / T5 are fixed to
 * provide the abstract-class token and to register the symbol binding.
 */
function buildTestTransportAdapter(): BatchAdapter {
  const stubStrategy: IExecutionStrategy = {
    name: 'stub',
    launch: async () => ({ kind: 'completed', status: JobStatus.COMPLETED }),
  };
  return {
    name: 'stub-transport',
    module: { module: class StubTransportModule {} },
    globalProviders: [
      {
        provide: BATCH_SCHEDULE_REGISTRY,
        useExisting: BatchScheduleRegistry,
      },
      {
        provide: EXECUTION_STRATEGY,
        useValue: stubStrategy,
      },
    ],
  };
}

describe('Task 48 — Library × PostgreSQL integration (live DB)', () => {
  let orm: MikroORM | null = null;
  let pgReachable = false;
  let skipReason = '';
  let em: EntityManager;
  let moduleRef: TestingModule;
  let launcher: JobLauncher;
  let registry: JobRegistry;

  function testIfPostgres(
    name: string,
    fn: () => Promise<void> | void,
    timeout?: number,
  ): void {
    test(
      name,
      async (ctx) => {
        if (!pgReachable) {
          console.warn(`[Library PostgreSQL E2E] SKIP (no PG): ${skipReason}`);
          return ctx.skip();
        }
        await fn();
      },
      timeout,
    );
  }

  beforeAll(async () => {
    try {
      orm = await MikroORM.init({
        driver: PostgreSqlDriver,
        ...PG_CONFIG,
        entities: [...BATCH_META_ENTITIES, ProductEntity],
      });
      pgReachable = true;
    } catch (err) {
      skipReason = formatPostgresError(err);
      console.warn(
        `[Library PostgreSQL E2E] PostgreSQL test DB unreachable on ` +
          `${PG_CONFIG.host}:${PG_CONFIG.port} (db=${PG_CONFIG.dbName}) — ` +
          `skipping live DB tests. Reason: ${skipReason}`,
      );
    }
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  beforeEach(async () => {
    if (!pgReachable || !orm) return;

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
      imports: [
        MikroOrmModule.forRoot({
          ...PG_CONFIG,
          driver: PostgreSqlDriver,
          entities: [...BATCH_META_ENTITIES, ProductEntity],
        }),
        MikroOrmAdapter.forRoot().module,
        NestBatchModule.forRoot({
          adapters: {
            persistence: MikroOrmAdapter.forRoot(),
            transport: buildTestTransportAdapter(),
          },
        }),
      ],
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

  testIfPostgres('1. Library + PostgreSQL: 1-step tasklet job runs to COMPLETED and persists execution state', async () => {
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
