import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  BatchExplorer,
  ChunkStepExecutor,
  DefinitionCompiler,
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
  JobExecutor,
  JobLauncher,
  JobRegistry,
  JobRepository,
  ListenerInvoker,
  NestBatchModule,
  TaskletStepExecutor,
  TransactionManager,
} from '@nest-batch/core';
import {
  MikroORMJobRepository,
  MikroORMTransactionManager,
  NestBatchMikroOrmModule,
} from '@nest-batch/mikro-orm';
import { BullmqBatchModule } from '@nest-batch/bullmq';
import {
  DynamicModule,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Provider,
} from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { BatchController } from './controller/batch.controller';
import { ProductEntity } from './entities/product.entity';
import { ImportProductsJob } from './jobs/import-products/import-products.job';
import { SkipLoggerListener } from './jobs/import-products/listeners/skip-logger.listener';
import { StepMetricsListener } from './jobs/import-products/listeners/step-metrics.listener';
import { ProductProcessor } from './jobs/import-products/processor/product.processor';
import { ProductWriter } from './jobs/import-products/writer/product.writer';

const DEFAULT_IMPORT_FILE = 'sample-data/products-valid.csv';

/**
 * Type of the batch transport the demo's `JobLauncher` should use.
 *
 * - `'in-process'` — wire the in-process strategy
 *   (`InProcessExecutionStrategy` + `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`).
 *   This is the lightweight, single-process mode: no Redis is required, and
 *   the `JobLauncher` blocks until the executor finishes. The
 *   `execution.status` returned to the controller is the terminal
 *   `COMPLETED` / `FAILED` status.
 * - `'bullmq'` — wire `@nest-batch/bullmq`'s `BullmqBatchModule`. The
 *   `BullMqExecutionStrategy` is bound to `EXECUTION_STRATEGY`, and the
 *   `JobLauncher` returns the `STARTING` execution row (a separate
 *   worker process consumes the BullMQ queue and drives the work to
 *   completion; the demo app itself does not start a worker).
 */
type BatchTransport = 'in-process' | 'bullmq';

/**
 * Resolves the batch transport mode from `process.env.BATCH_TRANSPORT`.
 *
 * Only the literal string `'in-process'` is treated as the in-process
 * mode. Anything else (including the empty string) is treated as the
 * `bullmq` mode — this keeps the documented default
 * (`BATCH_TRANSPORT` unset ⇒ bullmq) working without extra branching.
 */
function resolveBatchTransport(): BatchTransport {
  return process.env.BATCH_TRANSPORT === 'in-process' ? 'in-process' : 'bullmq';
}

/**
 * Builds the `import-products` job and registers it with the
 * `JobRegistry` on application bootstrap.
 *
 * Registered as a singleton via the `useFactory` provider below. The
 * `filePath` is captured at construction time — the MVP exposes a
 * single file per process; per-launch file overrides are passed via
 * the REST controller's request body.
 */
@Injectable()
class ImportProductsJobRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImportProductsJobRegistrar.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly compiler: DefinitionCompiler,
    private readonly explorer: BatchExplorer,
    private readonly importProductsJob: ImportProductsJob,
  ) {}

  onApplicationBootstrap(): void {
    const filePath = process.env.IMPORT_FILE ?? DEFAULT_IMPORT_FILE;
    this.importProductsJob.configure(filePath);

    const [discovered] = this.explorer.discoverFromProviders([
      { metatype: ImportProductsJob, instance: this.importProductsJob },
    ]);
    if (!discovered) {
      throw new Error('ImportProductsJob decorator metadata was not discovered');
    }

    const def = this.compiler.compileFromDiscovered(discovered);
    if (this.registry.has(def.id)) {
      this.logger.log(`Job "${def.id}" already registered; skipping duplicate registration`);
      return;
    }

    this.registry.register(def);
    this.logger.log(`Registered job "import-products" with filePath=${filePath}`);
  }
}

/**
 * Provider list that is identical in every transport mode:
 *
 *   - The demo's job-graph providers (`ProductProcessor`,
 *     `ProductWriter`, listeners) and the registrar that wires the
 *     `import-products` definition into the registry on bootstrap.
 *   - The `JobLauncher` itself, which is transport-agnostic.
 *
 * The `JobRepository` / `TransactionManager` bindings are NOT in
 * this list — they live on the `NestBatchModule.forRoot({...})`
 * call below (as `repository` / `transactionManager` options). That
 * keeps the bindings inside the global core module, where
 * `BullmqBatchModule` (an imported module) can see them. NestJS
 * encapsulation prevents providers in the root module from being
 * injected into providers of an imported module; promoting the
 * repository / transaction-manager bindings onto the global core
 * module side-steps that.
 *
 * The transport-mode-specific providers (in-process executors, the
 * BullMQ transport binding) are contributed by `buildAppModuleBody()`
 * below.
 */
const COMMON_PROVIDERS: readonly Provider[] = [
  ProductProcessor,
  ProductWriter,
  ImportProductsJob,
  SkipLoggerListener,
  StepMetricsListener,
  {
    provide: ImportProductsJobRegistrar,
    useFactory: (
      registry: JobRegistry,
      compiler: DefinitionCompiler,
      explorer: BatchExplorer,
      importProductsJob: ImportProductsJob,
    ) => new ImportProductsJobRegistrar(registry, compiler, explorer, importProductsJob),
    inject: [JobRegistry, DefinitionCompiler, BatchExplorer, ImportProductsJob],
  },
  JobLauncher,
];

/**
 * Build the dynamic module body for the resolved transport mode.
 *
 * The wiring splits in two directions:
 *
 *   - `in-process` needs the in-process strategy binding
 *     (`InProcessExecutionStrategy` +
 *     `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`) plus the executor
 *     subgraph (`JobExecutor`, `ChunkStepExecutor`,
 *     `TaskletStepExecutor`, `ListenerInvoker`).
 *   - `bullmq` needs `@nest-batch/bullmq`'s `BullmqBatchModule`,
 *     which already binds `EXECUTION_STRATEGY` to
 *     `BullMqExecutionStrategy`. The BullMQ runtime service also
 *     depends on `JobExecutor` + `JobRegistry`, so the executor
 *     class is registered in both modes (in `bullmq` mode it is
 *     only used by the worker, which the demo app does not start
 *     — it is still registered so the runtime service can be
 *     resolved if a worker is later added to the same process).
 *
 * The transport resolution is logged at module-build time so the
 * active mode is obvious from the boot logs.
 */
function buildAppModuleBody(): {
  imports: DynamicModule['imports'];
  controllers: DynamicModule['controllers'];
  providers: DynamicModule['providers'];
} {
  const transport = resolveBatchTransport();
  // Log the resolved transport before the providers are created
  // — the module is constructed by Nest before `onApplicationBootstrap`
  // fires, so a plain `Logger` call here is the earliest visible
  // signal of which mode is active.
  new Logger('AppModule').log(`Batch transport mode: ${transport}`);

  const mikroOrmImport = NestBatchMikroOrmModule.forRoot({
    // The batch meta-schema is owned by `@nest-batch/mikro-orm` and
    // is merged into `entities` by `forRoot()`. We only need to
    // pass the user-domain entities (`ProductEntity`); the batch
    // tables are added automatically.
    entities: [ProductEntity],
    dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5434),
    user: process.env.DATABASE_USER ?? 'demo',
    password: process.env.DATABASE_PASSWORD ?? 'demo',
    driver: PostgreSqlDriver,
  });

  if (transport === 'in-process') {
    return {
      imports: [
        AppConfigModule,
        mikroOrmImport,
        NestBatchModule.forRoot({
          repository: { provide: JobRepository, useClass: MikroORMJobRepository },
          transactionManager: {
            provide: TransactionManager,
            useClass: MikroORMTransactionManager,
          },
          // The runtime executor classes (`JobExecutor`,
          // `ChunkStepExecutor`, `TaskletStepExecutor`,
          // `ListenerInvoker`) need to be visible to the
          // in-process strategy's constructor (and to the
          // BullMQ runtime's `JobExecutor` parameter in
          // bullmq mode). They live on the global core module
          // via `extraProviders` so every transport can see
          // them. NestJS encapsulation would otherwise hide
          // them from sibling-package providers like the
          // BullMQ runtime service.
          extraProviders: [
            JobExecutor,
            ChunkStepExecutor,
            TaskletStepExecutor,
            ListenerInvoker,
          ],
        }),
      ],
      controllers: [BatchController],
      providers: [
        ...COMMON_PROVIDERS,
        // In-process execution subgraph. The strategy binding is
        // provided by `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`,
        // which wraps the same `InProcessExecutionStrategy` class
        // registered below so the `EXECUTION_STRATEGY` token
        // resolves to it.
        InProcessExecutionStrategy,
        IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
      ],
    };
  }

  // bullmq (default) — wire the BullMQ transport from the sibling
  // package. The package binds `EXECUTION_STRATEGY` to its
  // `BullMqExecutionStrategy`; no in-process strategy is needed
  // in this mode.
  //
  // The `BATCH_BULLMQ_AUTOSTART_WORKER` env var (test-only escape
  // hatch) lets a single-process deployment also start a worker
  // in-process. The default in production remains `false` (the
  // demo is launcher-only; the worker is a separate process). The
  // `BATCH_BULLMQ_KEY_PREFIX` env var (also test-only) lets the
  // e2e suite use an isolated Redis key namespace so concurrent
  // test runs do not collide on shared Redis state. Both are
  // opt-in: with neither set, the wiring is identical to the
  // pre-Task-21 behaviour.
  const autoStartWorker =
    process.env.BATCH_BULLMQ_AUTOSTART_WORKER === '1' ||
    process.env.BATCH_BULLMQ_AUTOSTART_WORKER === 'true';
  const keyPrefixOverride = process.env.BATCH_BULLMQ_KEY_PREFIX;
  return {
    imports: [
      AppConfigModule,
      mikroOrmImport,
      NestBatchModule.forRoot({
        repository: { provide: JobRepository, useClass: MikroORMJobRepository },
        transactionManager: {
          provide: TransactionManager,
          useClass: MikroORMTransactionManager,
        },
        // Same encapsulation rationale as the in-process branch:
        // the runtime executor classes must live on the global
        // core module so the imported `BullmqBatchModule` can
        // resolve them when constructing `BullmqRuntimeService`
        // (whose constructor takes a `JobExecutor`).
        extraProviders: [
          JobExecutor,
          ChunkStepExecutor,
          TaskletStepExecutor,
          ListenerInvoker,
        ],
      }),
      BullmqBatchModule.forRoot({
        connection: {
          host: process.env.REDIS_HOST ?? '127.0.0.1',
          port: Number(process.env.REDIS_PORT ?? 6379),
          ...(keyPrefixOverride !== undefined && keyPrefixOverride !== ''
            ? { keyPrefix: keyPrefixOverride }
            : {}),
        },
        // The demo app is a launcher-only deployment. The
        // worker runs in a separate process (see Task 21). The
        // producer side (the `Queue`) is what enqueues work;
        // the worker is responsible for consuming it. Test
        // code may set `BATCH_BULLMQ_AUTOSTART_WORKER=1` to
        // start the worker in-process for e2e assertions.
        autoStartWorker,
      }),
    ],
    controllers: [BatchController],
    providers: [
      ...COMMON_PROVIDERS,
      // The BullMQ transport itself is the
      // `BullMqExecutionStrategy` bound to `EXECUTION_STRATEGY`
      // — it is constructed by `BullmqBatchModule`. The runtime
      // service (`BullmqRuntimeService`) and the executor
      // subgraph (`JobExecutor`, `ChunkStepExecutor`,
      // `TaskletStepExecutor`, `ListenerInvoker`) are also wired
      // by `BullmqBatchModule` and `NestBatchModule`'s
      // `extraProviders` respectively. None need explicit
      // providers in this branch.
    ],
  };
}

/**
 * Root Nest module for the demo app. The class is a thin shell;
 * the actual wiring is produced by `buildAppModuleBody()` so the
 * transport mode can be selected at module-build time.
 *
 * `NestFactory.create(AppModule, ...)` (see `main.ts`) accepts
 * the class itself; Nest reads the `imports` / `providers` /
 * `controllers` from the decorator metadata, and the decorator
 * below returns the dynamic module produced by
 * `buildAppModuleBody()`. This keeps the public surface identical
 * to the pre-migration module: `main.ts` does not need to know
 * about the transport flag.
 */
@Module(buildAppModuleBody())
export class AppModule {}
