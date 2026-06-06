import {
  DynamicModule,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';

import type { BatchAdaptersConfig } from './adapter';
import { DefinitionCompiler } from '../compiler/definition-compiler';
import {
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
} from '../execution/in-process-execution-strategy';
import { BatchExplorer } from '../explorer/batch-explorer';
import { JobRegistry } from '../registry/job-registry';
import { BATCH_SCHEDULED_OPTIONS } from '../decorators/constants';
import type { BatchScheduledMetadata } from '../scheduling/batch-scheduled';
import {
  BatchScheduleRegistry,
  type BatchScheduleEntry,
} from './batch-schedule-registry';

/**
 * Re-export the default in-process strategy and its token binding so
 * the host app can wire them up alongside the rest of the batch
 * engine. The strategy is *not* auto-registered by
 * `NestBatchModule.forRoot()` (T2's body) because its constructor
 * requires `JobRepository` and `JobExecutor` — runtime deps the host
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
 * Stub options for `forRootAsync()`.
 *
 * TODO(core-factory-init/T2): rewrite `forRootAsync` to honour
 * `imports` / `inject` / `useFactory` against the new
 * `BatchAdaptersConfig` shape. The type lives here today only to
 * keep the file compiling — T2 will define the real contract.
 */
export interface NestBatchModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  useFactory: (
    ...args: unknown[]
  ) => Promise<NestBatchModuleOptions> | NestBatchModuleOptions;
  inject?: readonly unknown[];
}

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
 * TODO(core-factory-init/T2): rewrite `forRoot` / `forRootAsync` to:
 *   1. import each adapter's `DynamicModule` via
 *      `adapters.persistence.module` and `adapters.transport.module`;
 *   2. register each adapter's `globalProviders` into the module's
 *      own DI scope and re-export them;
 *   3. register core's own providers (`BatchExplorer`,
 *      `DefinitionCompiler`, `JobRegistry`, `JobExecutor`,
 *      `ChunkStepExecutor`, `TaskletStepExecutor`, `ListenerInvoker`,
 *      `FlowEvaluator`, `BatchScheduleRegistry`, `BatchBootstrapper`)
 *      and import `DiscoveryModule`;
 *   4. resolve `forRootAsync` through a sentinel factory provider
 *      that honours `imports` + `inject` (mirroring the
 *      `ConfigurableModuleBuilder` shape).
 *
 * Both factories are stubs in T1 so the file compiles after the
 * old `repository` / `transactionManager` / `executionStrategy` /
 * `extraProviders` options are removed. The stubs return a
 * minimal global `DynamicModule` that does not register any
 * providers — T2 replaces them with the real wiring.
 */
@Module({})
export class NestBatchModule {
  /**
   * Static (synchronous) configuration.
   *
   * STUB — see the class docstring. T2 fills this in.
   */
  static forRoot(_options: NestBatchModuleOptions): DynamicModule {
    return {
      module: NestBatchModule,
      global: true,
    };
  }

  /**
   * Async configuration — useful when the adapter set comes from
   * a config service or another async source.
   *
   * STUB — see the class docstring. T2 fills this in.
   */
  static forRootAsync(_options: NestBatchModuleAsyncOptions): DynamicModule {
    return {
      module: NestBatchModule,
      global: true,
    };
  }
}
