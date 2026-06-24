import { Module, type DynamicModule } from '@nestjs/common';

import type { BatchAdapter } from '../module/adapter';
import { EXECUTION_STRATEGY } from '../execution/execution-strategy';
import {
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
  InProcessExecutionStrategy,
} from '../execution/in-process-execution-strategy';
import { InProcessSchedule } from '../execution/in-process-schedule';

/**
 * Empty Nest module class that owns the in-process execution-strategy
 * providers.
 *
 * The class has no body on purpose: it is purely a `DynamicModule`
 * carrier for the `forRoot()` factory below. Nest's module system
 * requires *some* class to identify the module — the empty class is
 * the minimum possible surface and keeps the runtime allocation at
 * one class (no decorators, no lifecycle hooks, no metadata).
 */
@Module({})
export class InProcessModule {}

/**
 * `InProcessAdapter` — the default transport adapter for
 * `@nest-batch/core`.
 *
 * This is the **no-Redis** transport: jobs run synchronously inside
 * the launching process via `JobExecutor.execute(...)`, on the same
 * event loop that called `JobLauncher.launch(...)`. There is no
 * queue, no worker, no Redis connection, no AOF / Lua scripts /
 * stream events. The whole point of this adapter is to be the
 * "no transport runtime at all" option.
 *
 * Use it when:
 *
 *   - You do not need horizontal scale-out (one process, one
 *     launcher, jobs run inline).
 *   - You want the cheapest possible deployment — no extra
 *     infrastructure, no extra process to supervise.
 *   - You are building a library / dev-time harness and the queue
 *     runtime would be in the way.
 *   - You are migrating an existing batch app and want to validate
 *     the engine end-to-end before turning on a real transport.
 *
 * Switch to `@nest-batch/bullmq` (or a future transport) when you
 * need cross-process work distribution, technical retry at the
 * transport layer, or a queue-backed backpressure model. The
 * `IExecutionStrategy` polymorphism means the application code does
 * not change — only the `transport` slot in `adapters: { ... }` does.
 *
 * ## Why a dedicated adapter (and not a built-in default)?
 *
 * The new factory-pattern API takes `adapters: { persistence,
 * transport }` and both slots are *required* (see
 * `BatchAdaptersConfig`). Shipping the in-process transport as a
 * dedicated `BatchAdapter` rather than a hidden implicit default
 * keeps the `AppModule` wiring explicit at the call site — you can
 * read the host's `imports` array and see exactly which transport is
 * active. That pays off the first time you debug a "why is this
 * running inline?" question and need to grep for the transport.
 *
 * ## Wiring
 *
 * ```ts
 * import { Module } from '@nestjs/common';
 * import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
 * import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
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
 *
 * `InProcessAdapter.forRoot()` takes no options — the in-process
 * transport has no connection params, no credentials, no knobs to
 * tune. If you find yourself reaching for a `useFactory` to plumb
 * some "config" into it, you almost certainly want a real transport
 * adapter instead.
 *
 * ## Scheduling
 *
 * `InProcessSchedule` is registered as a transport global provider.
 * It consumes `BatchScheduleRegistry` after discovery/bootstrap and
 * turns non-inert `@BatchScheduled` cron ticks into
 * `JobLauncher.launch(...)` calls in this same process. That gives
 * single-process apps a real cron path without Redis or another
 * queue. It is intentionally not a distributed lock: multiple app
 * replicas will each run their own timer.
 *
 * ## DI scope
 *
 * The module is `global: true` and exports both the strategy class
 * and the `EXECUTION_STRATEGY` token. Three reasons for the `global`
 * flag:
 *
 *   1. `JobLauncher` (registered by `NestBatchModule`) is `@Inject(
 *      EXECUTION_STRATEGY )` — it needs the token visible at the
 *      application level, not just inside the adapter's own module.
 *   2. The host application is the only place that may want to
 *      inspect the strategy at runtime (e.g. for a `/healthz`
 *      endpoint reporting which transport is active). The `global`
 *      flag makes that work without forcing the host to re-import
 *      this module from every sub-module.
 *   3. Mirroring `NestBatchModule`'s own `global: true` keeps the
 *      pattern uniform across the engine and its adapters — the host
 *      author only needs to learn one module-visibility model.
 *
 * ## Why `globalProviders` is used
 *
 * The `BatchAdapter` interface allows a `globalProviders` field for
 * runtime classes (e.g. `JobExecutor`, `InProcessExecutionStrategy`)
 * that the adapter's *own* module needs to inject but that the host
 * should also be able to inject. This adapter lists
 * `InProcessExecutionStrategy`, `InProcessSchedule`, and the
 * `EXECUTION_STRATEGY` binding there so `NestBatchModule` can merge
 * them into the same provider graph as `JobLauncher`,
 * `BatchScheduleRegistry`, and the executor subgraph.
 *
 * ## Concurrency
 *
 * The default in-process strategy runs jobs on the caller's event
 * loop. A long-running step will block the launching process. This
 * is the contract: no concurrency, no parallelism, no out-of-band
 * execution. If you need concurrency, switch transports.
 */
export class InProcessAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { transport, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the in-process transport
   * has nothing to configure. The method is static so the adapter
   * can be referenced as a value (`adapters: { transport:
   * InProcessAdapter }`) without needing an instance, mirroring
   * the shape of the sibling adapter packages' own factories.
   *
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` exposing `InProcessExecutionStrategy` and the
   *   `EXECUTION_STRATEGY` token to the host application.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'in-process',
      module: buildInProcessDynamicModule(),
      globalProviders: [
        InProcessExecutionStrategy,
        InProcessSchedule,
        IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
      ],
    };
  }
}

/**
 * Build the `DynamicModule` payload for the in-process transport.
 *
 * Extracted from `InProcessAdapter.forRoot()` so the provider /
 * export list lives in one place — easier to read, easier to keep
 * the two arrays in sync if a new provider is ever added.
 *
 * The `EXECUTION_STRATEGY` token is exported (not just listed in
 * `providers`) so that host code can resolve the strategy directly
 * via `moduleRef.get(EXECUTION_STRATEGY)` — useful for `/healthz`
 * endpoints that need to report which transport is wired up.
 *
 * `InProcessExecutionStrategy` is also exported so host code can
 * inject the concrete class (not just the token) when type-strict
 * consumers prefer the class form.
 */
function buildInProcessDynamicModule(): DynamicModule {
  return {
    module: InProcessModule,
    global: true,
    providers: [IN_PROCESS_EXECUTION_STRATEGY_PROVIDER],
    exports: [IN_PROCESS_EXECUTION_STRATEGY_PROVIDER],
  };
}
