import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { EXECUTION_STRATEGY, type BatchAdapter } from '@nest-batch/core';

import { BullMqExecutionStrategy } from '../bullmq-execution-strategy';
import { BullmqRuntime } from '../bullmq-runtime';
import { BullmqSchedule } from '../bullmq-schedule';
import { resolveBullMqConnection } from '../connection';
import {
  BULLMQ_MODULE_OPTIONS,
  type BullMqModuleOptions,
  type ResolvedBullMqModuleOptions,
} from '../module-options';

/**
 * Empty Nest module class that owns the BullMQ transport's
 * provider graph.
 *
 * Mirrors `InProcessModule` in `@nest-batch/core/src/adapters/
 * in-process.adapter.ts`: the class has no body on purpose. It is
 * purely a `DynamicModule` carrier — Nest's module system requires
 * *some* class to identify the module, and the empty class is the
 * minimum possible surface (no decorators, no lifecycle hooks, no
 * metadata). All real behaviour lives on the providers.
 */
@Module({})
export class BullmqModule {}

/**
 * Sentinel token for the async-options factory chain.
 *
 * `forRootAsync` registers a `useFactory` provider under this token
 * that runs the user's factory, then a second provider
 * (`BULLMQ_MODULE_OPTIONS`) that depends on it and freezes the
 * resolved options. A duplicate `provide` for
 * `BULLMQ_MODULE_OPTIONS` would crash Nest's container, so the
 * chain uses this private symbol as the intermediate step.
 *
 * Mirrors the `Symbol.for('@nest-batch/bullmq/OPTIONS_FACTORY')`
 * used by the legacy `BullmqBatchModule.forRootAsync()` — the
 * `Symbol.for` key is process-scoped and stable across module
 * versions, so any host still wiring up the legacy class is not
 * affected.
 */
const OPTIONS_FACTORY: symbol = Symbol.for('@nest-batch/bullmq/OPTIONS_FACTORY');

/**
 * The list of exports the BullMQ adapter's `DynamicModule` exposes
 * to the host application.
 *
 * Centralised so the sync and async paths stay in lockstep — any
 * future addition (e.g. a `BullmqScheduler` controller) only needs
 * to be added here.
 *
 * The set mirrors the legacy `BullmqBatchModule.forRoot()` exports
 * (the `forRootAsync()` legacy path was missing
 * `BullmqRuntime` from `exports` — that omission is fixed
 * here, both paths now export the same five entries).
 *
 *   - `EXECUTION_STRATEGY` — the DI token, so host code (e.g. a
 *     `/healthz` endpoint) can resolve the strategy class via
 *     `moduleRef.get(EXECUTION_STRATEGY)`.
 *   - `BULLMQ_MODULE_OPTIONS` — the resolved connection / worker
 *     config bag, for inspection and (future) for per-role client
 *     builders.
 *   - `BullMqExecutionStrategy` — the concrete class, for type-
 *     strict consumers that prefer class injection.
 *   - `BullmqRuntime` — the runtime that owns the
 *     `Queue` / `Worker` / `QueueEvents` lifecycle.
 *   - `BullmqSchedule` — the runtime that owns the
 *     `@BatchScheduled` cron-to-BullMQ translation.
 */
const ADAPTER_EXPORTS: ReadonlyArray<
  symbol | typeof BullMqExecutionStrategy | typeof BullmqRuntime | typeof BullmqSchedule
> = [
  EXECUTION_STRATEGY,
  BULLMQ_MODULE_OPTIONS,
  BullMqExecutionStrategy,
  BullmqRuntime,
  BullmqSchedule,
];

/**
 * `BullmqAdapter` — the transport adapter for `@nest-batch/bullmq`
 * used by the new factory-pattern
 * `NestBatchModule.forRoot({ adapters: { transport, ... } })` API.
 *
 * Overrides the default `EXECUTION_STRATEGY` token with a BullMQ-
 * backed `IExecutionStrategy` (`BullMqExecutionStrategy`) and wires
 * the runtime services that own the BullMQ client lifecycle
 * (`BullmqRuntime` for step enqueue + worker, plus
 * `BullmqSchedule` for `@BatchScheduled` cron entries).
 *
 * Two static methods:
 *
 *   - `forRoot(options)` — synchronous configuration. The
 *     connection options are resolved up-front and frozen under
 *     the `BULLMQ_MODULE_OPTIONS` token. Use this when the Redis
 *     host is known at module composition time.
 *
 *   - `forRootAsync({ imports, inject, useFactory })` — async
 *     configuration. The factory is registered as a sentinel
 *     provider; the `BULLMQ_MODULE_OPTIONS` provider depends on
 *     it. Use this when the connection comes from a config
 *     service or another async source.
 *
 * The two methods share the same provider list via the
 * `buildStaticProviders` helper — the only difference is whether
 * `BULLMQ_MODULE_OPTIONS` is a value provider (sync) or a factory
 * provider that resolves the user's `useFactory` result (async).
 *
 * `globalProviders` is intentionally omitted. The recommended path
 * is to expose host-visible providers via the module's own
 * `exports` (see `ADAPTER_EXPORTS` above) — the `BatchAdapter`
 * interface's `globalProviders` field is for runtime classes the
 * adapter's own module needs but that core itself would also
 * re-export. `JobLauncher` (registered by `NestBatchModule`, not
 * by this adapter) injects the strategy by the `EXECUTION_STRATEGY`
 * token, which is already in `exports`, so the resolution chain
 * works without core having to know which adapter is active.
 *
 * @example
 * ```ts
 * // Synchronous wiring (connection known at module-build time)
 * import { Module } from '@nestjs/common';
 * import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
 * import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
 * import { BullmqAdapter } from '@nest-batch/bullmq';
 *
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({
 *       adapters: {
 *         persistence: MikroOrmAdapter,
 *         transport: BullmqAdapter.forRoot({
 *           connection: {
 *             host: process.env.REDIS_HOST,
 *             port: Number(process.env.REDIS_PORT),
 *             keyPrefix: 'nest-batch:',
 *           },
 *           autoStartWorker: true,
 *         }),
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * @example
 * ```ts
 * // Async wiring (connection sourced from ConfigService)
 * BullmqAdapter.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (cfg: ConfigService) => ({
 *     connection: {
 *       host: cfg.get<string>('redis.host'),
 *       port: cfg.get<number>('redis.port'),
 *       password: cfg.get<string>('redis.password'),
 *     },
 *   }),
 * });
 * ```
 */
export class BullmqAdapter {
  /**
   * Synchronous configuration.
   *
   * Resolves the connection options up-front (`resolveBullMqConnection`
   * fills in defaults + freezes the bag) and emits a
   * `BatchAdapter` whose `module` is a `global: true`
   * `DynamicModule` registering the strategy class, the runtime
   * services, the `EXECUTION_STRATEGY` binding, and the resolved
   * options as a value provider under `BULLMQ_MODULE_OPTIONS`.
   *
   * No options object is required: the module accepts an empty
   * `{}` and applies all defaults (host `127.0.0.1`, port `6379`,
   * keyPrefix `nest-batch:`, no auth, no TLS, `autoStartWorker:
   * false`).
   *
   * @param options - Connection + worker config. All fields optional.
   * @returns A `BatchAdapter` with `name: 'bullmq'` and the
   *   `BullmqModule` dynamic module.
   */
  static forRoot(options: BullMqModuleOptions = {}): BatchAdapter {
    const resolved: ResolvedBullMqModuleOptions = Object.freeze({
      connection: resolveBullMqConnection(options.connection),
      autoStartWorker: options.autoStartWorker ?? false,
    });
    return {
      name: 'bullmq',
      module: buildBullmqDynamicModule({
        providers: buildStaticProviders(resolved),
      }),
    };
  }

  /**
   * Async configuration — useful when the Redis connection comes
   * from a config service or another async provider.
   *
   * The shape mirrors `NestBatchModule.forRootAsync`:
   *   - `imports` is forwarded to the resulting
   *     `DynamicModule.imports` (so `ConfigModule` is available
   *     when the factory runs).
   *   - `inject` lists the providers the factory needs in its
   *     argument list.
   *   - `useFactory` resolves the options bag at module-build
   *     time. The factory's return value is treated as
   *     `BullMqModuleOptions` and is fed through
   *     `resolveBullMqConnection` by the `BULLMQ_MODULE_OPTIONS`
   *     factory provider (defaults applied, bag frozen).
   *
   * Implementation note: the factory is registered under the
   * package-private `OPTIONS_FACTORY` sentinel token; the
   * `BULLMQ_MODULE_OPTIONS` provider depends on it. This is the
   * same chain the legacy `BullmqBatchModule.forRootAsync` used
   * — the dynamic module is built off the static provider list,
   * with the static `BULLMQ_MODULE_OPTIONS` value provider
   * replaced by the async factory pair.
   *
   * @param asyncOptions - `{ imports, inject, useFactory }` bag.
   *   `useFactory` is required; `imports` and `inject` are
   *   optional and default to `[]`.
   * @returns A `BatchAdapter` with `name: 'bullmq'` and the
   *   `BullmqModule` dynamic module (with `imports` wired).
   */
  static forRootAsync(asyncOptions: {
    imports?: DynamicModule['imports'];
    inject?: readonly unknown[];
    useFactory: (...args: unknown[]) => Promise<BullMqModuleOptions> | BullMqModuleOptions;
  }): BatchAdapter {
    const factoryProvider: Provider = {
      provide: OPTIONS_FACTORY,
      useFactory: asyncOptions.useFactory as (...args: unknown[]) => unknown,
      inject: [...(asyncOptions.inject ?? [])] as Array<string | symbol | Function>,
    };

    const mergedOptionsProvider: Provider = {
      provide: BULLMQ_MODULE_OPTIONS,
      useFactory: (fromFactory: BullMqModuleOptions | undefined): ResolvedBullMqModuleOptions => {
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
    // crash Nest's container). We seed `buildStaticProviders`
    // with a placeholder resolved bag (its value is discarded
    // — the async provider overrides the slot) so the function
    // can be the single source of truth for the rest of the
    // provider list.
    const baseProviders = buildStaticProviders(
      Object.freeze({
        connection: resolveBullMqConnection(undefined),
        autoStartWorker: false,
      }),
    );
    const filtered = baseProviders.filter(
      (p) =>
        !(
          typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          (p as { provide: unknown }).provide === BULLMQ_MODULE_OPTIONS
        ),
    );

    return {
      name: 'bullmq',
      module: buildBullmqDynamicModule({
        providers: [factoryProvider, mergedOptionsProvider, ...filtered],
        imports: asyncOptions.imports,
      }),
    };
  }
}

/**
 * Build the static provider list shared by `forRoot()` and
 * `forRootAsync()`.
 *
 * Centralised so the sync and async paths declare the same set of
 * providers (and any future addition — e.g. a per-role client
 * builder — only needs to be added here).
 *
 * The async path then filters the `BULLMQ_MODULE_OPTIONS` entry
 * out of the returned array and replaces it with the factory
 * pair. Everything else is shared.
 */
function buildStaticProviders(resolved: ResolvedBullMqModuleOptions): Provider[] {
  return [
    BullMqExecutionStrategy,
    BullmqRuntime,
    BullmqSchedule,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: BullMqExecutionStrategy,
    },
    {
      provide: BULLMQ_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

/**
 * Build the `DynamicModule` payload for the BullMQ adapter.
 *
 * Extracted from the two factory methods so the provider /
 * export / global-true shape lives in one place. NestJS's
 * `validateExportedProvider` check rejects an `exports` entry
 * that is not in `providers` (or imported), so adding to one
 * without the other is a silent runtime failure — keeping the
 * two arrays synchronised by construction is the safest
 * pattern.
 *
 * `imports` is optional: `forRoot` does not need any (it has no
 * async providers), `forRootAsync` forwards the user's
 * `imports` (typically `ConfigModule`) so the factory's
 * `inject` targets resolve.
 */
function buildBullmqDynamicModule(args: {
  providers: Provider[];
  imports?: DynamicModule['imports'];
}): DynamicModule {
  const module: DynamicModule = {
    module: BullmqModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
  if (args.imports !== undefined) {
    return { ...module, imports: [...args.imports] };
  }
  return module;
}
