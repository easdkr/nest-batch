import {
  DynamicModule,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import type { BatchAdaptersConfig } from './adapter';
import { DefinitionCompiler } from '../compiler/definition-compiler';
import { BatchExplorer } from '../explorer/batch-explorer';
import { JobRegistry } from '../registry/job-registry';
import { JobExecutor } from '../execution/job-executor';
import { ChunkStepExecutor } from '../execution/chunk-step-executor';
import { TaskletStepExecutor } from '../execution/tasklet-step-executor';
import { ListenerInvoker } from '../execution/listener-invoker';
import { JobLauncher } from '../execution/job-launcher';
import {
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
} from '../execution/in-process-execution-strategy';
import { FlowEvaluator } from '../flow/flow-evaluator';
import { BATCH_SCHEDULED_OPTIONS } from '../decorators/constants';
import type { BatchScheduledMetadata } from '../scheduling/batch-scheduled';
import {
  BatchScheduleRegistry,
  type BatchScheduleEntry,
} from './batch-schedule-registry';
import {
  BATCH_SCHEDULE_REGISTRY,
  JOB_REPOSITORY_TOKEN,
  MODULE_OPTIONS_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from './tokens';
import { JobRepository } from '../core/repository/job-repository';
import { TransactionManager } from '../core/transaction/transaction-manager';

/**
 * Re-export the default in-process strategy and its token binding so
 * the host app can wire them up alongside the rest of the batch
 * engine. The strategy is *not* auto-registered by
 * `NestBatchModule.forRoot()` because its constructor requires
 * `JobRepository` and `JobExecutor` — runtime deps the host
 * supplies. The T4 `InProcessAdapter` factory does the wiring through
 * the adapter's own `DynamicModule.exports` so the runtime
 * resolution chain works without the core module having to know which
 * adapter is active.
 *
 * ```ts
 * import { InProcessAdapter, MikroOrmAdapter, NestBatchModule } from '@nest-batch/core';
 *
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({
 *       adapters: {
 *         persistence: MikroOrmAdapter,
 *         transport: InProcessAdapter,
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export { InProcessExecutionStrategy, IN_PROCESS_EXECUTION_STRATEGY_PROVIDER };

/**
 * Options for `NestBatchModule.forRoot()`.
 *
 * The whole configuration is the pair of adapters (persistence +
 * transport) the host picked. Both are required — the compiler
 * will reject an `adapters` bag that is missing one — and each
 * adapter is a self-contained `DynamicModule` core will import.
 * Sibling packages can no longer extend the options shape via
 * interface merging: the old `AdapterOptions` extension point is
 * gone because every adapter now owns its own `DynamicModule`
 * (and therefore its own config). Adapter authors that want
 * type-safe factory arguments should expose them on their own
 * adapter factory (e.g. `MikroOrmAdapter.forRoot({ ... })`).
 *
 *   - `adapters.persistence` — the adapter that owns the
 *     `JobRepository` + `TransactionManager` bindings (e.g.
 *     `MikroOrmAdapter`, `TypeOrmAdapter`).
 *   - `adapters.transport`   — the adapter that owns the
 *     `IExecutionStrategy` binding (e.g. `InProcessAdapter`,
 *     `BullmqAdapter`).
 */
export interface NestBatchModuleOptions {
  readonly adapters: BatchAdaptersConfig;
}

/**
 * Options for `NestBatchModule.forRootAsync()`.
 *
 * `imports` + `inject` + `useFactory` mirror the standard
 * `ConfigurableModuleBuilder` shape. The factory is registered as a
 * sentinel provider under `OPTIONS_FACTORY` (a `Symbol.for` token
 * stable across module boundaries), and `MODULE_OPTIONS_TOKEN` is
 * bound to its resolved `BatchAdaptersConfig` via a follow-up
 * `useFactory` provider.
 *
 * **Note on adapter module merging.** NestJS cannot dynamically
 * import a `DynamicModule` at module-build time, so the
 * `forRootAsync` path does NOT auto-merge the adapter modules'
 * `globalProviders` into the core module's `providers` list the way
 * `forRoot` does. Two consequences for the async path:
 *
 *   1. The adapter `DynamicModule`s must be passed in the caller's
 *      `imports` array directly (e.g.
 *      `imports: [MikroOrmAdapter.module, InProcessAdapter.module]`)
 *      so Nest sees them in the module graph.
 *   2. The factory's return value is used only for the
 *      `MODULE_OPTIONS_TOKEN` binding (adapters introspection);
 *      sibling packages and the host can read the resolved config
 *      via `@Inject(MODULE_OPTIONS_TOKEN)`.
 *
 * For the full auto-merge (adapter modules + `globalProviders`
 * registered into core's own DI scope), prefer `forRoot` with a
 * pre-resolved `BatchAdaptersConfig`. The async path is for
 * adapters whose factory needs to consult a config service or
 * another async provider to decide which adapter to plug in.
 */
export interface NestBatchModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  useFactory: (
    ...args: unknown[]
  ) => Promise<BatchAdaptersConfig> | BatchAdaptersConfig;
  inject?: readonly unknown[];
}

/**
 * Sentinel provider token used by `forRootAsync` to plumb the user's
 * `useFactory` through DI. The factory is registered under this
 * token, and `MODULE_OPTIONS_TOKEN` resolves to its output via a
 * follow-up `useFactory` provider.
 *
 * `Symbol.for(...)` makes the token stable across module boundaries:
 * tooling or sibling packages that know the description string can
 * resolve the same symbol without importing this file. Matches the
 * convention used by `BATCH_SCHEDULE_REGISTRY`, `MODULE_OPTIONS_TOKEN`,
 * `JOB_REPOSITORY_TOKEN`, etc. in `./tokens.ts`.
 */
const OPTIONS_FACTORY: symbol = Symbol.for('@nest-batch/core/OPTIONS_FACTORY');

/**
 * Hook that runs on `OnApplicationBootstrap` to wire together the
 * discovery → compile → register pipeline.
 *
 * Why a separate provider and not a method on `JobRegistry` or
 * `DefinitionCompiler`?
 *   - `BatchExplorer.onModuleInit` populates the discovered
 *     list once the DI container is ready. Compilation needs every
 *     `@Jobable` provider to be instantiated, so it must run *after*
 *     `onModuleInit`.
 *   - `OnApplicationBootstrap` is the latest point in Nest's lifecycle
 *     before the app actually starts handling requests, so all of:
 *     `forRoot` / `forRootAsync` providers, custom `useFactory` results,
 *     and user-supplied job classes, are guaranteed to be live.
 *   - Keeping the wire-up in a dedicated `BatchBootstrapper` means the
 *     explorer/compiler/registry stay pure (no `onApplicationBootstrap`
 *     coupling) and are independently testable.
 *
 * The bootstrapper also walks every discovered job for
 * `@BatchScheduled` metadata and registers the corresponding entries
 * into the `BatchScheduleRegistry` so the (future) runtime scheduler
 * has a single, stable place to read them from. Today, the registry is
 * metadata-only — no timers are installed.
 */
@Injectable()
export class BatchBootstrapper implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchBootstrapper.name);

  constructor(
    private readonly explorer: BatchExplorer,
    private readonly compiler: DefinitionCompiler,
    private readonly registry: JobRegistry,
    private readonly scheduleRegistry: BatchScheduleRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // 1. Compile + register every discovered job.
    for (const discovered of this.explorer.getDiscovered()) {
      const jobId = discovered.jobOptions.id;
      try {
        const def = this.compiler.compileFromDiscovered(discovered);
        this.registry.register(def);
        this.logger.log(`Registered job "${jobId}"`);
      } catch (err) {
        this.logger.error(
          `Failed to register job "${jobId}": ${(err as Error).message}`,
        );
        throw err;
      }
    }

    // 2. Walk the same discovered set for @BatchScheduled metadata
    //    and populate BatchScheduleRegistry. The metadata is stamped
    //    by the decorator via `SetMetadata(KEY, value)`, which Nest
    //    writes to the *function reference* of the decorated method
    //    (not to the prototype+name slot). We therefore read it from
    //    `prototype[name]` (the function), not from the (proto, name)
    //    tuple.
    for (const discovered of this.explorer.getDiscovered()) {
      const jobId = discovered.jobOptions.id;
      const prototype = discovered.classRef.prototype as Record<string, unknown>;
      for (const name of this.allMethodNames(prototype)) {
        const fn = prototype[name];
        if (typeof fn !== 'function') continue;
        const meta = Reflect.getMetadata(
          BATCH_SCHEDULED_OPTIONS,
          fn,
        ) as BatchScheduledMetadata | undefined;
        if (!meta) continue;
        const entry: BatchScheduleEntry = {
          jobId,
          methodName: name,
          cron: meta.cron,
          timezone: meta.options.timezone,
          overlap: meta.options.overlap,
          startAt: meta.options.startAt,
          endAt: meta.options.endAt,
          inert: meta.inert,
        };
        try {
          this.scheduleRegistry.register(entry);
          this.logger.log(
            `Registered schedule for job "${jobId}"::${name} (cron="${meta.cron}", tz="${meta.options.timezone}")`,
          );
        } catch (err) {
          this.logger.error(
            `Failed to register schedule for job "${jobId}"::${name}: ${
              (err as Error).message
            }`,
          );
          throw err;
        }
      }
    }
  }

  /**
   * Walk the prototype chain and return every own method name
   * (excluding `constructor`) up to (but not including)
   * `Object.prototype`. Same shape as `BatchExplorer.allMethodNames` —
   * we duplicate the walker here so the bootstrapper remains
   * independent of the explorer's internals.
   */
  private allMethodNames(prototype: object): Set<string> {
    const names = new Set<string>();
    let proto: object | null = prototype;
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        names.add(name);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return names;
  }
}

/**
 * Public Nest module that wires up the @nest-batch/core library.
 *
 * The module is a `global: true` `DynamicModule` whose `imports`,
 * `providers`, and `exports` are assembled at the call site by
 * `forRoot` (synchronous) or `forRootAsync` (sentinel-factory
 * pattern). In both paths the core providers and the executor
 * subgraph are auto-registered so the host does not have to wire
 * them by hand; adapter modules are imported as part of the same
 * `DynamicModule` so Nest's discovery phase sees every job class.
 *
 * @see {@link NestBatchModuleOptions} for the synchronous options shape
 * @see {@link NestBatchModuleAsyncOptions} for the async options shape
 * @see {@link BatchAdaptersConfig} for the adapter contract
 */
@Module({})
export class NestBatchModule {
  /**
   * Build a provider list from an adapter's `globalProviders`,
   * automatically aliasing the abstract `JobRepository` class to
   * `JOB_REPOSITORY_TOKEN` when the symbol is present but the class
   * itself is not directly provided.
   *
   * This fixes the NestJS DI resolution gap: `JobExecutor`,
   * `JobLauncher`, and `InProcessExecutionStrategy` all inject the
   * abstract `JobRepository`, but adapters typically bind their
   * concrete implementation to `JOB_REPOSITORY_TOKEN`. NestJS cannot
   * resolve abstract class → concrete subclass automatically, so we
   * inject the alias here.
   *
   * Idempotent: if `JobRepository` is already directly provided (e.g.
   * `{ provide: JobRepository, useClass: MyRepo }`), no extra alias is
   * added.
   */
  private static buildProviders(adapterGlobalProviders: readonly Provider[]): Provider[] {
    const providers = [...adapterGlobalProviders];

    const hasJobRepositoryToken = providers.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        'provide' in p &&
        p.provide === JOB_REPOSITORY_TOKEN,
    );

    const hasJobRepositoryClass = providers.some(
      (p) =>
        p === JobRepository ||
        (typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          p.provide === JobRepository),
    );

    if (hasJobRepositoryToken && !hasJobRepositoryClass) {
      providers.push({
        provide: JobRepository,
        useExisting: JOB_REPOSITORY_TOKEN,
      });
    }

    const hasTransactionManagerToken = providers.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        'provide' in p &&
        p.provide === TRANSACTION_MANAGER_TOKEN,
    );

    const hasTransactionManagerClass = providers.some(
      (p) =>
        p === TransactionManager ||
        (typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          p.provide === TransactionManager),
    );

    if (hasTransactionManagerToken && !hasTransactionManagerClass) {
      providers.push({
        provide: TransactionManager,
        useExisting: TRANSACTION_MANAGER_TOKEN,
      });
    }

    return providers;
  }

  /**
   * Best-effort resolution of `inject` tokens by reading the
   * `providers` metadata of modules listed in `imports`. This lets
   * `forRootAsync` evaluate a synchronous `useFactory` even when it
   * declares `inject` deps, provided those deps are `useValue`
   * providers exported by an imported module.
   *
   * Only `useValue` providers can be resolved this way — `useClass`
   * and `useFactory` providers need Nest's DI container and are
   * skipped.
   */
  private static resolveInjectValues(
    imports: NestBatchModuleAsyncOptions['imports'],
    inject: readonly unknown[],
  ): unknown[] {
    if (!inject || inject.length === 0) return [];

    const values: unknown[] = [];
    for (const token of inject) {
      let resolved: unknown = undefined;
      for (const mod of imports ?? []) {
        if (!mod) continue;

        let providers: Provider[] | undefined;

        if (typeof mod === 'object' && 'module' in mod) {
          const dynamicMod = mod as DynamicModule;
          providers = dynamicMod.providers;
          if (!providers && dynamicMod.module) {
            try {
              providers = Reflect.getMetadata('providers', dynamicMod.module);
            } catch {
              /* ignore metadata read failures */
            }
          }
        } else if (typeof mod === 'function') {
          try {
            providers = Reflect.getMetadata('providers', mod);
          } catch {
            /* ignore metadata read failures */
          }
        }

        for (const p of providers ?? []) {
          if (
            typeof p === 'object' &&
            p !== null &&
            'provide' in p &&
            p.provide === token &&
            'useValue' in p
          ) {
            resolved = p.useValue;
            break;
          }
        }
        if (resolved !== undefined) break;
      }
      values.push(resolved);
    }
    return values;
  }

  /**
   * Static (synchronous) configuration.
   *
   * Takes the resolved `BatchAdaptersConfig` and builds a
   * `global: true` `DynamicModule` that:
   *
   *   1. imports each adapter's `DynamicModule`
   *      (`adapters.persistence.module` and `adapters.transport.module`);
   *   2. imports `DiscoveryModule` from `@nestjs/core` so the explorer
   *      can use Nest's `DiscoveryService`;
   *   3. registers core's own providers — `JobRegistry`,
   *      `DefinitionCompiler`, `BatchExplorer`, `FlowEvaluator`,
   *      `BatchScheduleRegistry`, `BatchBootstrapper` — and the
   *      executor subgraph (`JobExecutor`, `ChunkStepExecutor`,
   *      `TaskletStepExecutor`, `ListenerInvoker`) so the host
   *      does not have to wire them by hand;
   *   4. registers each adapter's `globalProviders` (e.g. the
   *      `JobRepository` / `TransactionManager` implementations
   *      from a persistence adapter) so the host can inject them
   *      too;
   *   5. binds the `BatchAdaptersConfig` to `MODULE_OPTIONS_TOKEN`
   *      via a value provider for adapter introspection.
   */
  static forRoot(options: NestBatchModuleOptions): DynamicModule {
    const { adapters } = options;
    const persistenceProviders = NestBatchModule.buildProviders(
      adapters.persistence.globalProviders ?? [],
    );
    const transportProviders = NestBatchModule.buildProviders(
      adapters.transport.globalProviders ?? [],
    );

    return {
      module: NestBatchModule,
      global: true,
      imports: [
        adapters.persistence.module,
        adapters.transport.module,
        DiscoveryModule,
      ],
      providers: [
        // Core classes (discovery + compile + register).
        JobRegistry,
        DefinitionCompiler,
        BatchExplorer,
        FlowEvaluator,
        BatchScheduleRegistry,
        BatchBootstrapper,
        // Executor subgraph (JobExecutor → Chunk/Tasklet/Listener).
        JobExecutor,
        ChunkStepExecutor,
        TaskletStepExecutor,
        ListenerInvoker,
        JobLauncher,
        // Resolved options bag for adapter introspection.
        {
          provide: MODULE_OPTIONS_TOKEN,
          useValue: adapters,
        },
        // Schedule registry symbol alias — the symbol itself
        // must be a provider (not just a class export) so the
        // `exports` entry below resolves through Nest's DI
        // validation.
        {
          provide: BATCH_SCHEDULE_REGISTRY,
          useExisting: BatchScheduleRegistry,
        },
        // Adapter-supplied global providers (e.g. JobRepository
        // / TransactionManager implementations).
        ...persistenceProviders,
        ...transportProviders,
      ],
      exports: [
        // Core classes — exported so sibling packages and the
        // host app can resolve them from the global module chain.
        JobRegistry,
        DefinitionCompiler,
        BatchExplorer,
        FlowEvaluator,
        BatchScheduleRegistry,
        BatchBootstrapper,
        // Tokens — exported so adapters can bind to them via
        // `@Inject(MODULE_OPTIONS_TOKEN)` and host code can read
        // the schedule registry by its stable symbol.
        BATCH_SCHEDULE_REGISTRY,
        MODULE_OPTIONS_TOKEN,
        // Executor subgraph — exported so adapters (e.g. the
        // `InProcessExecutionStrategy`) and host code can inject
        // them.
        JobExecutor,
        ChunkStepExecutor,
        TaskletStepExecutor,
        ListenerInvoker,
        JobLauncher,
        // Adapter-supplied global providers — re-exported so the
        // host can resolve the persistence + transport bindings
        // from the global module chain.
        ...persistenceProviders,
        ...transportProviders,
      ],
    };
  }

  /**
   * Async configuration — useful when the adapter set comes from a
   * config service or another async source.
   *
   * Mirrors the `BullmqBatchModule.forRootAsync` pattern: the user's
   * `useFactory` is registered as a sentinel provider under
   * `OPTIONS_FACTORY`, and `MODULE_OPTIONS_TOKEN` is bound to its
   * resolved `BatchAdaptersConfig` via a follow-up `useFactory`
   * provider. The user's `imports` + `inject` are forwarded as-is
   * so the factory can pull from `ConfigService` or any other
   * DI-bound dependency.
   *
   * See the `NestBatchModuleAsyncOptions` JSDoc for the adapter
   * module merging caveat — the async path does not auto-merge
   * the adapter modules' `globalProviders`. The adapter
   * `DynamicModule`s must be passed in the caller's `imports`
   * array so Nest sees them in the module graph; the factory's
   * return value is used only for `MODULE_OPTIONS_TOKEN`.
   */
  static forRootAsync(
    options: NestBatchModuleAsyncOptions,
  ): DynamicModule | Promise<DynamicModule> {
    const { imports = [], inject = [], useFactory } = options;

    // Try to evaluate the factory synchronously so we can merge
    // adapter `globalProviders` at module-build time (mirroring
    // what `forRoot` does). If the factory is async or needs
    // injected deps we can't resolve, fall back to the pure
    // sentinel-factory path.
    const injectValues = NestBatchModule.resolveInjectValues(imports, inject);
    const factoryResult = useFactory(...injectValues);

    if (factoryResult instanceof Promise) {
      return factoryResult.then((adapters) =>
        NestBatchModule.buildAsyncModule(options, adapters),
      );
    }

    return NestBatchModule.buildAsyncModule(options, factoryResult);
  }

  /**
   * Shared module builder used by both the sync and async branches
   * of `forRootAsync`. When the factory result is available
   * synchronously we merge adapter `globalProviders` (plus the
   * `JobRepository` alias) into core's own provider list, exactly
   * like `forRoot` does.
   */
  private static buildAsyncModule(
    options: NestBatchModuleAsyncOptions,
    adapters: BatchAdaptersConfig,
  ): DynamicModule {
    const { imports = [], inject = [], useFactory } = options;

    const persistenceProviders = NestBatchModule.buildProviders(
      adapters.persistence.globalProviders ?? [],
    );
    const transportProviders = NestBatchModule.buildProviders(
      adapters.transport.globalProviders ?? [],
    );

    // Sentinel factory provider: holds the user's `useFactory` and
    // any `inject` deps. Other providers can pull the resolved
    // `BatchAdaptersConfig` via `@Inject(OPTIONS_FACTORY)` if they
    // need to.
    const factoryProvider: Provider = {
      provide: OPTIONS_FACTORY,
      useFactory: useFactory as (...args: unknown[]) => unknown,
      inject: [...inject] as Array<string | symbol | Function>,
    };

    // Options provider: bridges the sentinel factory to the
    // canonical `MODULE_OPTIONS_TOKEN` so adapters + host code can
    // read the resolved config by its stable symbol.
    const optionsProvider: Provider = {
      provide: MODULE_OPTIONS_TOKEN,
      useFactory: (
        fromFactory: BatchAdaptersConfig | undefined,
      ): BatchAdaptersConfig | undefined => fromFactory,
      inject: [OPTIONS_FACTORY],
    };

    return {
      module: NestBatchModule,
      global: true,
      imports: [
        ...imports,
        adapters.persistence.module,
        adapters.transport.module,
        DiscoveryModule,
      ],
      providers: [
        // Core classes (discovery + compile + register).
        JobRegistry,
        DefinitionCompiler,
        BatchExplorer,
        FlowEvaluator,
        BatchScheduleRegistry,
        BatchBootstrapper,
        // Executor subgraph (JobExecutor → Chunk/Tasklet/Listener).
        JobExecutor,
        ChunkStepExecutor,
        TaskletStepExecutor,
        ListenerInvoker,
        JobLauncher,
        {
          provide: BATCH_SCHEDULE_REGISTRY,
          useExisting: BatchScheduleRegistry,
        },
        // Adapter-supplied global providers (e.g. JobRepository
        // / TransactionManager implementations).
        ...persistenceProviders,
        ...transportProviders,
        // Sentinel factory + options provider (the async path).
        factoryProvider,
        optionsProvider,
      ],
      exports: [
        // Core classes.
        JobRegistry,
        DefinitionCompiler,
        BatchExplorer,
        FlowEvaluator,
        BatchScheduleRegistry,
        BatchBootstrapper,
        // Tokens.
        BATCH_SCHEDULE_REGISTRY,
        MODULE_OPTIONS_TOKEN,
        // Executor subgraph.
        JobExecutor,
        ChunkStepExecutor,
        TaskletStepExecutor,
        ListenerInvoker,
        JobLauncher,
        // Adapter-supplied global providers — re-exported so the
        // host can resolve the persistence + transport bindings
        // from the global module chain.
        ...persistenceProviders,
        ...transportProviders,
      ],
    };
  }
}
