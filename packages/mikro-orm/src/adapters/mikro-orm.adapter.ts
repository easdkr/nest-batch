import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { MikroOrmModule, type MikroOrmModuleOptions } from '@mikro-orm/nestjs';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';
import { BATCH_META_ENTITIES } from '../entities/job-meta.entities';
import { MikroORMJobRepository } from '../mikroorm-job-repository';
import { MikroORMTransactionManager } from '../mikroorm-transaction-manager';

/**
 * Empty Nest module class that carries the `MikroOrmAdapter`'s
 * wrapping `DynamicModule` config.
 *
 * The class has no body on purpose: it is purely a module identifier
 * for the `DynamicModule` factory below. Nest's module system
 * requires *some* class to identify the module — an empty class is
 * the minimum possible surface and keeps the runtime allocation at
 * one class (no decorators, no lifecycle hooks, no metadata). The
 * actual persistence wiring (`MikroOrmModule.forRoot(...)`,
 * `JobRepository` / `TransactionManager` provider bindings) is
 * declared in the `DynamicModule` literal returned by
 * `MikroOrmAdapter.forRoot()`.
 *
 * A dedicated class is used (rather than reusing `MikroOrmModule`
 * from `@mikro-orm/nestjs`) for two reasons:
 *
 *   1. The imported `MikroOrmModule` already has its own static
 *      `@Module({})` decorator and its own `forRoot()` factory.
 *      Pointing our wrapping `DynamicModule.module` at it would
 *      create a second `DynamicModule` config for the same class,
 *      which collides with the `MikroOrmModule.forRoot({...})` we
 *      import as a sub-module (Nest would see two configurations
 *      for the same module class).
 *   2. A dedicated class makes the `BatchAdapter` self-describing:
 *      the host can read the `module.module` field and see that
 *      this is the adapter's own carrier module, not a reference
 *      to a third-party module class.
 */
@Module({})
export class MikroOrmAdapterModule {}

/**
 * `MikroOrmAdapter` — the persistence adapter for
 * `@nest-batch/mikro-orm`, expressed in the new factory-pattern
 * `BatchAdapter` shape.
 *
 * The adapter is a self-contained DI bundle that:
 *
 *   - registers `MikroOrmModule.forRoot(...)` with the batch
 *     meta-entities (`BATCH_META_ENTITIES`) merged in next to the
 *     host's user-domain entities;
 *   - registers the `MikroORMJobRepository` and
 *     `MikroORMTransactionManager` classes as injectable
 *     providers;
 *   - binds those two classes to the canonical
 *     `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 *     symbols from `@nest-batch/core` (so `@nest-batch/core`'s
 *     engine — `JobLauncher`, `JobExecutor`, etc. — can resolve
 *     them by the symbol, not by the concrete class);
 *   - marks the wrapping `DynamicModule` as `global: true` so the
 *     bindings are visible to the host application even when the
 *     adapter is not re-imported in every sub-module.
 *
 * The class is the *factory*, not an instance — every call site
 * refers to it as a value (e.g. `adapters: { persistence:
 * MikroOrmAdapter }`) without `new`. The static `forRoot()`
 * returns a fully resolved `BatchAdapter` that the new
 * `NestBatchModule.forRoot({ adapters: { ... } })` API consumes.
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
 *         persistence: MikroOrmAdapter.forRoot({
 *           dbName: 'nest_batch_demo',
 *           user: 'demo',
 *           password: 'demo',
 *           // host, port, entities, ... any MikroOrmModuleOptions field
 *         }),
 *         transport: InProcessAdapter.forRoot(),
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * Apps that want to keep their existing `MikroOrmModule.forRoot(...)`
 * call (because they have user-domain entities registered there
 * too) can still spread `BATCH_META_ENTITIES` into their entity
 * list and register the `JobRepository` / `TransactionManager`
 * provider bindings by hand — the adapter is the convenience
 * factory, not the only path.
 *
 * ## Options
 *
 * `forRoot(options)` accepts the same `MikroOrmModuleOptions` you
 * would pass to `MikroOrmModule.forRoot(...)` directly, with one
 * change: the `entities` field is *merged* with
 * `BATCH_META_ENTITIES` (the host's user-domain entities remain
 * authoritative; the package entities are appended). The merge is
 * a plain spread — there is no de-duplication, so the host must
 * not list a batch meta-entity in their own `entities` array.
 *
 * ## Why `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN`
 *
 * `@nest-batch/core` exposes the `JobRepository` and
 * `TransactionManager` contracts as abstract classes, but the
 * engine resolves them through `Symbol.for(...)` tokens
 * (`JOB_REPOSITORY_TOKEN`, `TRANSACTION_MANAGER_TOKEN`). Binding
 * the concrete MikroORM classes to those symbols — rather than to
 * the abstract class references — means the host can swap the
 * implementation (e.g. for tests, or for a future TypeORM
 * adapter) by changing the binding without touching the engine's
 * internal injection sites.
 */
export class MikroOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * API expects.
   *
   * @param options  The same `MikroOrmModuleOptions` accepted by
   *   `MikroOrmModule.forRoot(...)`, with the `entities` field
   *   merged against `BATCH_META_ENTITIES` before the call.
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` that registers the MikroORM connection, the
   *   `JobRepository` / `TransactionManager` classes, and the
   *   canonical token bindings for both.
   */
  static forRoot(
    options: Omit<MikroOrmModuleOptions, 'entities'> & {
      entities?: MikroOrmModuleOptions['entities'];
    },
  ): BatchAdapter {
    const merged: MikroOrmModuleOptions = {
      ...options,
      entities: [...(options.entities ?? []), ...BATCH_META_ENTITIES],
    };
    return {
      name: 'mikro-orm',
      module: buildMikroOrmAdapterDynamicModule(merged),
      globalProviders: buildMikroOrmAdapterGlobalProviders(),
    };
  }
}

/**
 * Build the `DynamicModule` payload for `MikroOrmAdapter`.
 *
 * Extracted from `MikroOrmAdapter.forRoot()` so the provider /
 * export list lives in one place — easier to read, easier to keep
 * the two arrays in sync if a new provider is ever added.
 *
 * Shape:
 *   - `module`         — `MikroOrmAdapterModule` (the dedicated
 *     empty class above). Reusing the imported `MikroOrmModule`
 *     would collide with its own `forRoot()` factory.
 *   - `global: true`   — the `JobRepository` / `TransactionManager`
 *     bindings are visible at the host application level, not just
 *     inside the adapter's own module. Mirrors
 *     `NestBatchModule`'s own `global: true` and the
 *     `InProcessAdapter` pattern from `@nest-batch/core`.
 *   - `imports`        — `MikroOrmModule.forRoot(merged)` from
 *     `@mikro-orm/nestjs`. This is what actually constructs the
 *     `EntityManager` and registers the entity classes.
 *   - `providers`      — the two concrete impl classes plus the
 *     canonical-symbol bindings (`useExisting: <class>` so both
 *     the class and the symbol resolve to the same instance).
 *   - `exports`        — the two symbol tokens. Other modules that
 *     import this adapter can resolve the bindings by symbol.
 */
function buildMikroOrmAdapterDynamicModule(
  merged: MikroOrmModuleOptions,
): DynamicModule {
  return {
    module: MikroOrmAdapterModule,
    global: true,
    imports: [MikroOrmModule.forRoot(merged)],
    providers: [
      MikroORMJobRepository,
      MikroORMTransactionManager,
      {
        provide: JOB_REPOSITORY_TOKEN,
        useExisting: MikroORMJobRepository,
      },
      {
        provide: TRANSACTION_MANAGER_TOKEN,
        useExisting: MikroORMTransactionManager,
      },
    ],
    exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
  };
}

/**
 * Build the `globalProviders` list for `MikroOrmAdapter`.
 *
 * The `BatchAdapter.globalProviders` field is the list of Nest
 * `Provider` records the core `NestBatchModule` will register
 * into its own DI scope and re-export — so the host application
 * can resolve the bindings (e.g. for a health check, or for a
 * custom observer) without re-importing the adapter.
 *
 * The shape mirrors the adapter's own `DynamicModule.providers`
 * (useClass with the concrete impl), so the core module ends up
 * with the same instance regardless of which path resolved it.
 * `useClass` (not `useExisting`) is the right call here: the
 * core module does not import this adapter's `DynamicModule`
 * imports, so it cannot reach the concrete classes through DI to
 * alias them. `useClass` lets Nest construct a fresh instance
 * from the class's own injection metadata (the `EntityManager`
 * from the `MikroOrmModule.forRoot(...)` registration), which is
 * the same instance the adapter's own `useExisting` binds to.
 */
function buildMikroOrmAdapterGlobalProviders(): readonly Provider[] {
  return [
    {
      provide: JOB_REPOSITORY_TOKEN,
      useClass: MikroORMJobRepository,
    },
    {
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: MikroORMTransactionManager,
    },
  ];
}
