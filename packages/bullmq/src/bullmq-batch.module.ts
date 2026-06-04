import {
  DynamicModule,
  Module,
  Provider,
} from '@nestjs/common';

import {
  EXECUTION_STRATEGY,
  type AdapterProvider,
} from '@nest-batch/core';
// `JOB_REPOSITORY_TOKEN` is imported from `@nest-batch/core` (above
// in the existing `core` import surface) by the sibling runtime
// service. It is intentionally NOT added to this module's `exports`
// or `providers`:
//   - The host wires the actual `JobRepository` via
//     `NestBatchModule.forRoot({ repository: { provide: JOB_REPOSITORY_TOKEN, ... } })`.
//   - `NestBatchModule` is `global: true`, so the binding lives in
//     the application-level container and `BullmqRuntimeService`
//     (this module's only consumer of the token) resolves it via
//     the global module chain — no local export or provider needed.
//   - Adding the token to `exports` alone fails NestJS's static
//     `validateExportedProvider` check (the symbol is not in this
//     module's `providers` / `imports` list of metatypes). Adding
//     it to `providers` as a passthrough creates a DI cycle:
//     the local lookup for the token finds the in-progress
//     passthrough factory and returns `undefined`, which breaks
//     the worker's `repository.getJobExecution(...)` call.
// Verifying the wiring: `pnpm --filter @nest-batch/bullmq test`
// must reach the runtime service construction (it does, in
// `tests/bullmq-runtime.test.ts` — the `Redis-down` test path
// instantiates the full DI graph and the `DB-first` test reaches
// `BullmqRuntimeService.launch()` and the worker's `processJob`).
// If the global chain were broken, both would fail with
// `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN` — they
// do not.

import { BullMqExecutionStrategy } from './bullmq-execution-strategy';
import { BullmqRuntimeService } from './bullmq-runtime.service';
import { BullmqScheduleService } from './bullmq-schedule.service';
import { resolveBullMqConnection } from './connection';
import {
  BULLMQ_MODULE_OPTIONS,
  type BullMqModuleOptions,
  type ResolvedBullMqModuleOptions,
} from './module-options';

/**
 * Public Nest dynamic module for `@nest-batch/bullmq`.
 *
 * Wires the package into the host's DI graph:
 *   - registers `BullMqExecutionStrategy` (the T17 stub) as a
 *     provider, bound to `@nest-batch/core`'s `EXECUTION_STRATEGY`
 *     token via a `useExisting` provider;
 *   - resolves + freezes the connection options and stores them
 *     under `BULLMQ_MODULE_OPTIONS` so the strategy (and T18's
 *     real runtime) can read them via `@Inject(BULLMQ_MODULE_OPTIONS)`.
 *
 * T17 scope (per the plan):
 *   - The strategy is a documented stub; `launch()` does not
 *     enqueue.
 *   - T18 replaces the stub with the real `Queue` / `Worker` /
 *     `QueueEvents` / `FlowProducer` wiring.
 *
 * The `EXECUTION_STRATEGY` provider is exported under
 * `EXECUTION_STRATEGY` so the host can inject the strategy
 * directly (for inspection / health checks) — Nest refuses to
 * export a token that is not part of the module's `providers`
 * list, so the symbol is included in `exports` as well.
 *
 * Usage:
 * ```ts
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({ /* repository, transactionManager, ... *\/ }),
 *     BullmqBatchModule.forRoot({
 *       connection: { host: '127.0.0.1', port: 6379, keyPrefix: 'nest-batch:' },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * Or, async:
 * ```ts
 * BullmqBatchModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (cfg: ConfigService) => ({
 *     connection: { host: cfg.get('REDIS_HOST'), port: cfg.get('REDIS_PORT') },
 *   }),
 * })
 * ```
 */
@Module({})
export class BullmqBatchModule {
  /**
   * Static (synchronous) configuration.
   *
   * Resolves the connection options up-front, freezes them, and
   * emits a `DynamicModule` that:
   *   - registers `BullMqExecutionStrategy` as a class provider
   *     (so it can be DI-injected and `@Optional()`-resolved by
   *     the strategy's own `BULLMQ_MODULE_OPTIONS` consumer),
   *   - registers the `EXECUTION_STRATEGY` binding via
   *     `useExisting: BullMqExecutionStrategy` so the
   *     `JobLauncher`'s `@Inject(EXECUTION_STRATEGY)` resolves to
   *     the same instance,
   *   - registers a value provider for the resolved options under
   *     `BULLMQ_MODULE_OPTIONS`.
   */
  static forRoot(options: BullMqModuleOptions = {}): DynamicModule {
    const resolved: ResolvedBullMqModuleOptions = Object.freeze({
      connection: resolveBullMqConnection(options.connection),
      autoStartWorker: options.autoStartWorker ?? false,
    });
    return {
      module: BullmqBatchModule,
      global: true,
      providers: buildStaticProviders(resolved),
      exports: [
        EXECUTION_STRATEGY,
        BULLMQ_MODULE_OPTIONS,
        BullMqExecutionStrategy,
        BullmqRuntimeService,
        BullmqScheduleService,
      ],
    };
  }

  /**
   * Async configuration — useful when the Redis connection is
   * sourced from a config service or another async provider.
   *
   * The shape mirrors `NestBatchModule.forRootAsync`:
   *   - `imports` is forwarded to the resulting `DynamicModule.imports`,
   *   - `inject` + `useFactory` resolve the options bag at
   *     module-build time (the factory is registered as a sentinel
   *     provider that the merged-options provider depends on).
   *
   * T17 only needs the connection options; the async factory is the
   * recommended way to source them from a config service today and
   * the natural extension point for T18's per-role client builders
   * (which can stay in `forRoot`/`forRootAsync` and consume
   * `BULLMQ_MODULE_OPTIONS` once it is registered).
   */
  static forRootAsync(asyncOptions: {
    imports?: DynamicModule['imports'];
    inject?: readonly unknown[];
    useFactory: (
      ...args: unknown[]
    ) => Promise<BullMqModuleOptions> | BullMqModuleOptions;
  }): DynamicModule {
    const OPTIONS_FACTORY = Symbol.for('@nest-batch/bullmq/OPTIONS_FACTORY');

    const factoryProvider: Provider = {
      provide: OPTIONS_FACTORY,
      useFactory: asyncOptions.useFactory as (...args: unknown[]) => unknown,
      inject: [...(asyncOptions.inject ?? [])] as Array<string | symbol | Function>,
    };

    const mergedOptionsProvider: Provider = {
      provide: BULLMQ_MODULE_OPTIONS,
      useFactory: (
        fromFactory: BullMqModuleOptions | undefined,
      ): ResolvedBullMqModuleOptions => {
        return Object.freeze({
          connection: resolveBullMqConnection(fromFactory?.connection),
          autoStartWorker: fromFactory?.autoStartWorker ?? false,
        });
      },
      inject: [OPTIONS_FACTORY],
    };

    // The static provider list is the same as `forRoot` except
    // the value provider for `BULLMQ_MODULE_OPTIONS` is replaced
    // with the async factory above (a duplicate `provide` would
    // crash Nest's container).
    const baseProviders = buildStaticProviders(
      // Placeholder — the async provider below overrides this
      // exact slot. The placeholder exists only so we can call
      // `buildStaticProviders` to get the canonical class +
      // EXECUTION_STRATEGY providers list.
      Object.freeze({
        connection: resolveBullMqConnection(undefined),
        autoStartWorker: false,
      }),
    );
    const filtered = baseProviders.filter(
      (p) => !(typeof p === 'object' && p !== null && 'provide' in p && p.provide === BULLMQ_MODULE_OPTIONS),
    );

    return {
      module: BullmqBatchModule,
      global: true,
      imports: [...(asyncOptions.imports ?? [])],
      providers: [factoryProvider, mergedOptionsProvider, ...filtered],
      exports: [
        EXECUTION_STRATEGY,
        BULLMQ_MODULE_OPTIONS,
        BullMqExecutionStrategy,
        BullmqScheduleService,
      ],
    };
  }
}

/**
 * Build the static provider list for `forRoot()`.
 *
 * Centralised so the static and async paths share the same
 * provider declarations (and any future addition to the list —
 * e.g. a `OnApplicationBootstrap` worker starter in T18 — only
 * needs to be added here).
 */
function buildStaticProviders(
  resolved: ResolvedBullMqModuleOptions,
): Provider[] {
  const providers: Provider[] = [
    BullMqExecutionStrategy,
    BullmqRuntimeService,
    BullmqScheduleService,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: BullMqExecutionStrategy,
    },
    {
      provide: BULLMQ_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
  return providers;
}

/**
 * Re-export of the package's public surface.
 *
 * Kept in a barrel so consumers can `import { BullmqBatchModule,
 * BullMqExecutionStrategy } from '@nest-batch/bullmq'` without
 * reaching into individual files. The barrel is the *only* entry
 * point the host should depend on; internal modules (e.g.
 * `./bullmq-execution-strategy`, `./module-options`) are
 * implementation details and may move.
 */
export type { AdapterProvider };
