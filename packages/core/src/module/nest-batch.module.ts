import {
  DynamicModule,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { DefinitionCompiler } from '../compiler/definition-compiler';
import { ChunkStepExecutor } from '../execution/chunk-step-executor';
import {
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
} from '../execution/in-process-execution-strategy';
import { JobExecutor } from '../execution/job-executor';
import { JobLauncher } from '../execution/job-launcher';
import { ListenerInvoker } from '../execution/listener-invoker';
import { TaskletStepExecutor } from '../execution/tasklet-step-executor';
import { BatchExplorer } from '../explorer/batch-explorer';
import { FlowEvaluator } from '../flow/flow-evaluator';
import { JobRegistry } from '../registry/job-registry';
import { BATCH_SCHEDULED_OPTIONS } from '../decorators/constants';
import type { BatchScheduledMetadata } from '../scheduling/batch-scheduled';

import type { AdapterOptions } from './adapter-options';
import {
  BatchScheduleRegistry,
  type BatchScheduleEntry,
} from './batch-schedule-registry';
import {
  BATCH_SCHEDULE_REGISTRY,
  JOB_REPOSITORY_TOKEN,
  LEGACY_BATCH_OPTIONS_TOKEN,
  MODULE_OPTIONS_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  EXECUTION_STRATEGY,
} from './tokens';

/**
 * Re-export the default in-process strategy and its token binding so
 * apps can wire them up alongside the rest of their `JobRepository` /
 * `JobExecutor` providers. The strategy is *not* auto-registered by
 * `NestBatchModule.forRoot()` because its constructor requires
 * `JobRepository` and `JobExecutor` — runtime deps that the host app
 * owns (the module's discovery/registry surface intentionally stays
 * free of runtime-side providers). Apps that want the default
 * in-process execution target add the strategy to their own
 * `providers` array, e.g.:
 *
 * ```ts
 * @Module({
 *   imports: [NestBatchModule.forRoot()],
 *   providers: [
 *     { provide: JobRepository, useClass: MikroORMJobRepository },
 *     JobExecutor,
 *     InProcessExecutionStrategy,
 *     IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * Sibling packages (e.g. `@nest-batch/bullmq`) replace the
 * `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER` binding with their own
 * transport strategy; `JobLauncher` itself is unchanged.
 */
export { InProcessExecutionStrategy, IN_PROCESS_EXECUTION_STRATEGY_PROVIDER };

/**
 * Token-override descriptor for a single integration.
 *
 * Sibling packages (and host apps that prefer token-based DI over
 * class-based DI) describe their override as a standard Nest
 * `Provider`. The module accepts this directly so the host does not
 * have to learn a custom DSL.
 */
export type AdapterProvider = Provider;

/**
 * Options for `NestBatchModule.forRoot()` and `forRootAsync()`.
 *
 * The base fields (`explorer`) are core-level. The shape is an
 * extension of `AdapterOptions` so sibling packages can contribute
 * their own fields via TypeScript interface merging. At runtime the
 * full options bag is stored under the `MODULE_OPTIONS_TOKEN` symbol
 * — adapters read it back through `Inject(MODULE_OPTIONS_TOKEN)`.
 *
 *   - `extraProviders`     — additional Nest `Provider` records
 *     contributed by sibling packages or the host app. They are
 *     appended to the module's `providers` array, so they are
 *     available to inject into the module's own wiring (e.g. the
 *     explorer / compiler) just like core's own providers.
 *
 *   - `repository`         — an explicit provider that binds the
 *     adapter's `JobRepository` implementation to the
 *     `JOB_REPOSITORY_TOKEN`. This is the recommended way for
 *     adapter packages to wire their repository into core without
 *     having to ask the host to add a separate `providers` entry.
 *
 *   - `transactionManager` — same idea, but for `TransactionManager`.
 *     The repository is expected to use the same transaction manager
 *     (e.g. share the same `EntityManager`).
 *
 *   - `executionStrategy`  — overrides the `EXECUTION_STRATEGY` token.
 *     The default is the in-process strategy (provided by the host
 *     via `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`). Sibling packages
 *     pass a transport strategy here.
 */
export interface NestBatchModuleOptions extends AdapterOptions {
  /** When `false`, skip automatic discovery of `@Jobable` providers.
   *  Reserved for future use; not yet implemented. */
  explorer?: boolean;

  /** Additional providers contributed by sibling packages. */
  extraProviders?: readonly AdapterProvider[];

  /** Provider that binds an adapter's `JobRepository` to `JOB_REPOSITORY_TOKEN`. */
  repository?: AdapterProvider;

  /** Provider that binds an adapter's `TransactionManager` to `TRANSACTION_MANAGER_TOKEN`. */
  transactionManager?: AdapterProvider;

  /** Provider that binds a transport's `IExecutionStrategy` to `EXECUTION_STRATEGY`. */
  executionStrategy?: AdapterProvider;
}

/**
 * Options for `NestBatchModule.forRootAsync()`. Mirrors the standard
 * Nest dynamic-module factory shape (same as `ConfigModule.forRootAsync`,
 * `ScheduleModule.forRootAsync`, etc.) but exposes the same
 * `extraProviders` / `repository` / `transactionManager` /
 * `executionStrategy` overrides that `forRoot()` accepts.
 */
export interface NestBatchModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  /**
   * Factory that returns (or resolves to) `NestBatchModuleOptions`.
   * Any provider listed in `inject` is available as an argument.
   */
  useFactory: (
    ...args: unknown[]
  ) => Promise<NestBatchModuleOptions> | NestBatchModuleOptions;
  inject?: readonly unknown[];

  /** Additional providers contributed by sibling packages. */
  extraProviders?: readonly AdapterProvider[];

  /** Provider that binds an adapter's `JobRepository` to `JOB_REPOSITORY_TOKEN`. */
  repository?: AdapterProvider;

  /** Provider that binds an adapter's `TransactionManager` to `TRANSACTION_MANAGER_TOKEN`. */
  transactionManager?: AdapterProvider;

  /** Provider that binds a transport's `IExecutionStrategy` to `EXECUTION_STRATEGY`. */
  executionStrategy?: AdapterProvider;
}

/**
 * Internal helper: extract the four "module-owned" override fields
 * from a `NestBatchModuleOptions` bag, and return the extra options
 * (anything that is not one of those four) as the new bag we expose
 * via `MODULE_OPTIONS_TOKEN`. The returned `extraOptions` is what
 * adapter packages see when they inject `MODULE_OPTIONS_TOKEN`.
 *
 * This split lets the module grow more override slots (e.g.
 * `listeners`, `idGenerator`) without adapter packages having to
 * filter the bag themselves.
 *
 * `providerToken` is the actual DI token a provider binds to, when
 * the host supplied one (e.g. `JOB_REPOSITORY_TOKEN` for a
 * `repository: { provide: JOB_REPOSITORY_TOKEN, useClass: ... }`
 * override). We extract it so the export list can include the
 * user-facing token — Nest only exports registered providers, and
 * the user might use a custom string/symbol key.
 */
function splitOptions(
  opts: NestBatchModuleOptions | undefined,
): {
  explorer: boolean;
  extraProviders: readonly AdapterProvider[];
  repository: AdapterProvider | undefined;
  repositoryToken: symbol | string | undefined;
  transactionManager: AdapterProvider | undefined;
  transactionManagerToken: symbol | string | undefined;
  executionStrategy: AdapterProvider | undefined;
  executionStrategyToken: symbol | string | undefined;
  extraOptions: Record<string, unknown>;
} {
  if (opts === undefined) {
    return {
      explorer: true,
      extraProviders: [],
      repository: undefined,
      repositoryToken: undefined,
      transactionManager: undefined,
      transactionManagerToken: undefined,
      executionStrategy: undefined,
      executionStrategyToken: undefined,
      extraOptions: {},
    };
  }
  const {
    explorer = true,
    extraProviders = [],
    repository,
    transactionManager,
    executionStrategy,
    ...extraOptions
  } = opts;
  return {
    explorer,
    extraProviders,
    repository,
    repositoryToken: extractToken(repository),
    transactionManager,
    transactionManagerToken: extractToken(transactionManager),
    executionStrategy,
    executionStrategyToken: extractToken(executionStrategy),
    extraOptions,
  };
}

/**
 * Extract the `provide` value from a Nest `Provider` record, when it
 * is a string/symbol token. Returns `undefined` for class-based
 * providers (whose `provide` is a class constructor — these are
 * already part of the module's exports through the class itself).
 */
function extractToken(
  provider: AdapterProvider | undefined,
): symbol | string | undefined {
  if (provider === undefined) return undefined;
  if (typeof provider === 'function') return undefined; // class
  if (typeof provider !== 'object' || provider === null) return undefined;
  const provide = (provider as { provide?: unknown }).provide;
  if (typeof provide === 'string' || typeof provide === 'symbol') {
    return provide;
  }
  return undefined;
}

/**
 * Build the full provider list for the module, in declaration order:
 *
 *   1. `MODULE_OPTIONS_TOKEN` (symbol) — the resolved options bag.
 *   2. `LEGACY_BATCH_OPTIONS_TOKEN` (string) — the same bag under
 *      the old `'BATCH_OPTIONS'` key, for backwards compatibility.
 *   3. Optional token-override providers (`repository`,
 *      `transactionManager`, `executionStrategy`) when supplied.
 *   4. `extraProviders` contributed by sibling packages.
 *   5. Core's own providers (`BatchExplorer`, `DefinitionCompiler`,
 *      `JobRegistry`, `FlowEvaluator`, `BatchScheduleRegistry`,
 *      `BatchBootstrapper`).
 *
 * `BatchScheduleRegistry` is a singleton provided by the module so
 * `BatchExplorer` / `BatchBootstrapper` can inject it without the
 * host having to register it.
 */
function buildProviders(
  resolved: ReturnType<typeof splitOptions>,
  originalOptions: NestBatchModuleOptions | undefined,
): Provider[] {
  const providers: Provider[] = [];

  // 1. MODULE_OPTIONS_TOKEN (symbol) — the new canonical home.
  //    The value is the FULL options bag minus the provider records
  //    themselves (those are registered as their own providers, not
  //    inlined in the options). `explorer` is included so adapter
  //    packages can introspect whether discovery is enabled.
  providers.push({
    provide: MODULE_OPTIONS_TOKEN,
    useValue: Object.freeze({
      explorer: resolved.explorer,
      ...resolved.extraOptions,
    }),
  });

  // 2. LEGACY_BATCH_OPTIONS_TOKEN (string) — preserves the original
  //    pre-Task-12 behaviour: the value is the options bag exactly as
  //    the host passed it (so `forRoot()` → `{}` and
  //    `forRoot({ explorer: true })` → `{ explorer: true }`).
  //    Adapter packages SHOULD migrate to `MODULE_OPTIONS_TOKEN`.
  providers.push({
    provide: LEGACY_BATCH_OPTIONS_TOKEN,
    useValue: Object.freeze({ ...(originalOptions ?? {}) }),
  });

  // 3. Token-override providers (only if the host supplied one).
  if (resolved.repository !== undefined) {
    providers.push(resolved.repository);
  }
  if (resolved.transactionManager !== undefined) {
    providers.push(resolved.transactionManager);
  }
  if (resolved.executionStrategy !== undefined) {
    providers.push(resolved.executionStrategy);
  }

  // 4. extraProviders from sibling packages.
  for (const p of resolved.extraProviders) {
    providers.push(p);
  }

  // 5. Core's own providers. The order here is the canonical source
  //    of truth for the module's DI graph. The class is registered
  //    as the canonical instance, and the symbol token is aliased to
  //    it via `useExisting` so consumers can inject by either
  //    `Inject(BatchScheduleRegistry)` or
  //    `Inject(BATCH_SCHEDULE_REGISTRY)`.
  providers.push(
    BatchExplorer,
    DefinitionCompiler,
    JobRegistry,
    FlowEvaluator,
    BatchScheduleRegistry,
    { provide: BATCH_SCHEDULE_REGISTRY, useExisting: BatchScheduleRegistry },
    BatchBootstrapper,
  );

  return providers;
}

/**
 * Hook that runs on `OnApplicationBootstrap` to wire together the
 * discovery → compile → register pipeline.
 *
 * Why a separate provider and not a method on `JobRegistry` or
 * `DefinitionCompiler`?
 *   - `BatchExplorer.onModuleInit` (Task 7) populates the discovered
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
 * Both `forRoot()` and `forRootAsync()`:
 *   - register `BatchExplorer`, `DefinitionCompiler`, `JobRegistry`,
 *     `BatchScheduleRegistry`, and `BatchBootstrapper` as providers;
 *   - import `DiscoveryModule` (for `DiscoveryService` + `MetadataScanner`);
 *   - export `JobRegistry`, `DefinitionCompiler`, `BatchExplorer`,
 *     `FlowEvaluator`, and `BatchScheduleRegistry` so consumers can
 *     inject them from outside;
 *   - expose the resolved options bag under `MODULE_OPTIONS_TOKEN`
 *     (symbol) AND `'BATCH_OPTIONS'` (string, legacy).
 *
 * The module is `global: true` so consumers don't have to import it in
 * every sub-module. This matches `@nestjs/cqrs` and `@nestjs/schedule`
 * conventions.
 */
@Module({})
export class NestBatchModule {
  /**
   * Static (synchronous) configuration.
   *
   * @example
   * ```ts
   * @Module({ imports: [NestBatchModule.forRoot()] })
   * class AppModule {}
   *
   * // With sibling-package overrides
   * @Module({
   *   imports: [
   *     NestBatchModule.forRoot({
   *       repository: { provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository },
   *       transactionManager: { provide: TRANSACTION_MANAGER_TOKEN, useClass: MikroORMTransactionManager },
   *       extraProviders: [/* sibling wiring *\/],
   *     }),
   *   ],
   * })
   * class AppModule {}
   * ```
   */
  static forRoot(options: NestBatchModuleOptions = {}): DynamicModule {
    const resolved = splitOptions(options);
    // Only export token-override providers that are actually
    // registered. Nest refuses to export a token that is not part of
    // the module's `providers` list, so we filter based on whether
    // the host actually supplied an override.
    const exportsList: (string | symbol | Function | DynamicModule)[] = [
      JobRegistry,
      DefinitionCompiler,
      BatchExplorer,
      FlowEvaluator,
      BatchScheduleRegistry,
      MODULE_OPTIONS_TOKEN,
    ];
    if (resolved.repositoryToken !== undefined) {
      exportsList.push(resolved.repositoryToken);
    }
    if (resolved.transactionManagerToken !== undefined) {
      exportsList.push(resolved.transactionManagerToken);
    }
    if (resolved.executionStrategyToken !== undefined) {
      exportsList.push(resolved.executionStrategyToken);
    }
    return {
      module: NestBatchModule,
      global: true,
      imports: [DiscoveryModule],
      providers: buildProviders(resolved, options),
      exports: exportsList,
    };
  }

  /**
   * Async configuration — useful when options depend on other providers
   * (e.g. `ConfigService`) or need to be loaded asynchronously (e.g.
   * from a remote config service).
   *
   * The `useFactory` is the only place where adapter options can be
   * resolved lazily; the module's provider list is then constructed
   * from the resolved bag in the same way as `forRoot()`.
   *
   * @example
   * ```ts
   * NestBatchModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     repository: { provide: JOB_REPOSITORY_TOKEN, useClass: cfg.get('BATCH_REPOSITORY') },
   *   }),
   * })
   * ```
   */
  static forRootAsync(options: NestBatchModuleAsyncOptions): DynamicModule {
    // We resolve the options *at module-build time* via a sentinel
    // factory provider, then feed the result into `buildProviders`.
    // The factory itself is registered in `providers` so it can
    // honour `imports` + `inject`.
    const OPTIONS_FACTORY = Symbol.for('@nest-batch/core/OPTIONS_FACTORY');

    const factoryProvider: Provider = {
      provide: OPTIONS_FACTORY,
      useFactory: options.useFactory as (...args: unknown[]) => unknown,
      inject: [...(options.inject ?? [])] as Array<string | symbol | Function>,
    };

    // Static overrides from the async options bag (these don't need
    // the factory — they're known at module-build time).
    const staticResolved = splitOptions({
      extraProviders: options.extraProviders,
      repository: options.repository,
      transactionManager: options.transactionManager,
      executionStrategy: options.executionStrategy,
    });

    // The MODULE_OPTIONS_TOKEN / LEGACY_BATCH_OPTIONS_TOKEN providers
    // need the *merged* result of the static overrides AND the
    // factory's output. We achieve that with a small wrapper
    // provider that reads both and produces the final value.
    const mergedOptionsProvider: Provider = {
      provide: MODULE_OPTIONS_TOKEN,
      useFactory: (
        fromFactory: NestBatchModuleOptions | undefined,
      ): Record<string, unknown> => {
        const fromFactoryResolved = splitOptions(fromFactory ?? {});
        const merged: Record<string, unknown> = {
          explorer: fromFactoryResolved.explorer,
          ...fromFactoryResolved.extraOptions,
        };
        // Static overrides win on conflict for the well-known slots;
        // the factory contributes any extra adapter fields.
        if (staticResolved.repository !== undefined) {
          merged['repository'] = '<static override>';
        }
        if (staticResolved.transactionManager !== undefined) {
          merged['transactionManager'] = '<static override>';
        }
        if (staticResolved.executionStrategy !== undefined) {
          merged['executionStrategy'] = '<static override>';
        }
        return Object.freeze(merged);
      },
      inject: [OPTIONS_FACTORY],
    };

    const legacyOptionsProvider: Provider = {
      provide: LEGACY_BATCH_OPTIONS_TOKEN,
      useFactory: (opts: Record<string, unknown> | undefined) => {
        // Preserve pre-Task-12 behavior: the legacy `'BATCH_OPTIONS'`
        // value is the bag exactly as the factory returned it (so
        // `forRootAsync({ useFactory: () => ({ explorer: true }) })`
        // resolves to `{ explorer: true }`, not to a resolved form).
        return Object.freeze({ ...(opts ?? {}) });
      },
      inject: [OPTIONS_FACTORY],
    };

    // Build the rest of the providers (token overrides + extra + core).
    // We pass `undefined` for the legacy options bag because the
    // async path has its own legacy provider below.
    const rest = buildProviders(
      {
        ...staticResolved,
        extraOptions: {}, // already merged into the wrapped provider above
      },
      undefined,
    );

    // The factory is internal — drop the wrapped `MODULE_OPTIONS_TOKEN`
    // entry from `rest` (it would conflict with `mergedOptionsProvider`).
    const restFiltered = rest.filter(
      (p) => !(typeof p === 'object' && p !== null && 'provide' in p && p.provide === MODULE_OPTIONS_TOKEN),
    );
    // Same for the legacy token.
    const restFiltered2 = restFiltered.filter(
      (p) => !(typeof p === 'object' && p !== null && 'provide' in p && p.provide === LEGACY_BATCH_OPTIONS_TOKEN),
    );

    return {
      module: NestBatchModule,
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        factoryProvider,
        mergedOptionsProvider,
        legacyOptionsProvider,
        ...restFiltered2,
      ],
      exports: [
        JobRegistry,
        DefinitionCompiler,
        BatchExplorer,
        FlowEvaluator,
        BatchScheduleRegistry,
        MODULE_OPTIONS_TOKEN,
        ...(staticResolved.repositoryToken !== undefined
          ? [staticResolved.repositoryToken]
          : []),
        ...(staticResolved.transactionManagerToken !== undefined
          ? [staticResolved.transactionManagerToken]
          : []),
        ...(staticResolved.executionStrategyToken !== undefined
          ? [staticResolved.executionStrategyToken]
          : []),
      ],
    };
  }
}
