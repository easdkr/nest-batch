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
 * The bootstrapper logs and rethrows on compile errors so a misconfigured
 * job fails the app start — silent failures here would lead to confusing
 * "job not found" errors at launch time (Task 19).
 */
@Injectable()
export class BatchBootstrapper implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchBootstrapper.name);

  constructor(
    private readonly explorer: BatchExplorer,
    private readonly compiler: DefinitionCompiler,
    private readonly registry: JobRegistry,
  ) {}

  onApplicationBootstrap(): void {
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
  }
}

/**
 * Options for `NestBatchModule.forRoot()`.
 *
 * `explorer` is reserved for a future option to disable automatic
 * `@Jobable` discovery (e.g. for apps that build jobs exclusively through
 * the fluent builder API and want to skip the metadata scan). It is
 * accepted today so the API is forward-compatible; behavior is unchanged
 * while it is `true` (the default) or `undefined`.
 */
export interface NestBatchModuleOptions {
  /** When `false`, skip automatic discovery of `@Jobable` providers.
   *  Reserved for future use; not yet implemented. */
  explorer?: boolean;
}

/**
 * Options for `NestBatchModule.forRootAsync()`. Mirrors the standard
 * Nest dynamic-module factory shape (same as `ConfigModule.forRootAsync`,
 * `ScheduleModule.forRootAsync`, etc.).
 *
 * The `BATCH_OPTIONS` provider is registered but unused for now — it is
 * reserved for future options (e.g., disabling the explorer, custom
 * validator, etc.). Wiring it up today means downstream tasks can
 * read it without an API change.
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
}

/**
 * Public Nest module that wires up the @nest-batch/core library.
 *
 * Both `forRoot()` and `forRootAsync()`:
 *   - register `BatchExplorer`, `DefinitionCompiler`, `JobRegistry`,
 *     and `BatchBootstrapper` as providers;
 *   - import `DiscoveryModule` (for `DiscoveryService` + `MetadataScanner`);
 *   - export `JobRegistry`, `DefinitionCompiler`, and `BatchExplorer` so
 *     consumers can inject them from outside.
 *
 * The module is `global: true` so consumers don't have to import it in
 * every sub-module. This matches `@nestjs/cqrs` and `@nestjs/schedule`
 * conventions.
 *
 * No actual job execution lives here — that's Task 19 (JobLauncher).
 * This module is *purely* the discovery → compile → register wire-up.
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
   * ```
   */
  static forRoot(options: NestBatchModuleOptions = {}): DynamicModule {
    const optionsProvider: Provider = {
      provide: 'BATCH_OPTIONS',
      useValue: options,
    };

    return {
      module: NestBatchModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        BatchExplorer,
        DefinitionCompiler,
        JobRegistry,
        FlowEvaluator,
        BatchBootstrapper,
      ],
      exports: [JobRegistry, DefinitionCompiler, BatchExplorer, FlowEvaluator],
    };
  }

  /**
   * Async configuration — useful when options depend on other providers
   * (e.g. `ConfigService`) or need to be loaded asynchronously (e.g.
   * from a remote config service).
   *
   * @example
   * ```ts
   * NestBatchModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({ explorer: cfg.get('BATCH_EXPLORER') }),
   * })
   * ```
   */
  static forRootAsync(options: NestBatchModuleAsyncOptions): DynamicModule {
    const optionsProvider = {
      provide: 'BATCH_OPTIONS' as const,
      useFactory: options.useFactory as (...args: unknown[]) => unknown,
      inject: [...(options.inject ?? [])] as Array<
        string | symbol | Function
      >,
    };

    return {
      module: NestBatchModule,
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        optionsProvider,
        BatchExplorer,
        DefinitionCompiler,
        JobRegistry,
        FlowEvaluator,
        BatchBootstrapper,
      ],
      exports: [JobRegistry, DefinitionCompiler, BatchExplorer, FlowEvaluator],
    };
  }
}
