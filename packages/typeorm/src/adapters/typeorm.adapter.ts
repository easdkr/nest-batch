import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { EntityTarget } from 'typeorm';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { BATCH_META_ENTITIES } from '../entities/job-meta.entities';
import { TypeOrmJobRepository } from '../repository/typeorm-job-repository';
import { TypeOrmTransactionManager } from '../transaction/typeorm-transaction-manager';

/**
 * Options for `TypeOrmAdapter.forRoot()`.
 *
 * The shape is the same one `@nestjs/typeorm`'s
 * `TypeOrmModule.forRoot()` accepts, minus the `entities` field.
 * The only override is that the host may pass an optional list of
 * user-domain entities; the six batch meta entities owned by this
 * package are always appended (and they are never silently
 * shadowed by the host's list — the spread order means the
 * package's tables are registered last so the host cannot
 * accidentally redefine a `batch_*` table).
 *
 * Any standard `DataSourceOptions` field flows through unchanged:
 * `type`, `host`, `port`, `username`, `password`, `database`,
 * `synchronize`, `migrationsRun`, `migrations`, `logging`, etc.
 * The bundled `CreateBatchMeta1700000000000` migration should be
 * added to the host's `migrations` array (or to a separate
 * migration list it points at via `migrationsTableName` /
 * `migrationsRun`).
 */
export type TypeOrmAdapterOptions = Omit<TypeOrmModuleOptions, 'entities'> & {
  /**
   * Optional list of user-domain entities to include in the
   * `DataSource`. The batch meta entities are appended
   * automatically; this list is for everything else.
   */
  readonly entities?: readonly EntityTarget<unknown>[];
};

/**
 * Empty Nest module class that owns the TypeORM batch adapter
 * providers.
 *
 * Same minimal-class pattern as `MikroOrmAdapterModule` in
 * `@nest-batch/mikro-orm` and `InProcessModule` in
 * `@nest-batch/core` — Nest needs *some* class to identify the
 * module, and an empty `@Module({})` class is the smallest
 * possible surface. No decorators, no lifecycle hooks, no
 * metadata beyond the empty module decorator.
 *
 * A dedicated class is used (rather than reusing `TypeOrmModule`
 * from `@nestjs/typeorm`) for the same reason as the
 * `MikroOrmAdapterModule` choice: the imported `TypeOrmModule`
 * already has its own static `@Module({})` decorator and its own
 * `forRoot()` factory. Pointing our wrapping `DynamicModule.module`
 * at it would create a second `DynamicModule` config for the same
 * class, which collides with the `TypeOrmModule.forRoot({...})` we
 * import as a sub-module (Nest would see two configurations for
 * the same module class).
 */
@Module({})
export class TypeOrmBatchModule {}

/**
 * `TypeOrmAdapter` — the TypeORM 1.0.0 persistence adapter for
 * `@nest-batch/core`.
 *
 * This is the **DB-backed** persistence adapter. It owns the
 * `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` bindings
 * for the TypeORM 1.0.0 driver: the `TypeOrmJobRepository` (which
 * reads/writes the six batch meta tables) and the
 * `TypeOrmTransactionManager` (which wraps user callbacks in
 * `dataSource.transaction(...)`). The contract guarantees and the
 * DB-first semantics are documented on the implementation classes
 * themselves.
 *
 * ## Why a dedicated adapter (and not a built-in default)?
 *
 * The new factory-pattern API takes `adapters: { persistence,
 * transport }` and both slots are *required* (see
 * `BatchAdaptersConfig` in `@nest-batch/core`). Shipping the
 * TypeORM persistence layer as a dedicated `BatchAdapter` rather
 * than an implicit default keeps the host's `AppModule` wiring
 * explicit at the call site — you can read the host's `imports`
 * array and see exactly which persistence backend is active.
 * That pays off the first time you debug a "why is the job not
 * committing?" question and need to grep for the adapter.
 *
 * ## Wiring
 *
 * ```ts
 * import { Module } from '@nestjs/common';
 * import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
 * import { TypeOrmAdapter } from '@nest-batch/typeorm';
 *
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({
 *       adapters: {
 *         persistence: TypeOrmAdapter.forRoot({
 *           type: 'postgres',
 *           host: '127.0.0.1',
 *           port: 5434,
 *           username: 'demo',
 *           password: 'demo',
 *           database: 'nest_batch_demo',
 *           entities: [/* your user-domain entities *\/],
 *           migrations: [CreateBatchMeta1700000000000],
 *           migrationsRun: true,
 *         }),
 *         transport: InProcessAdapter,
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 *
 * The adapter calls `TypeOrmModule.forRoot(merged)` internally,
 * so the host does **not** need to call `TypeOrmModule.forRoot()`
 * separately. Calling it twice is not supported by `@nestjs/typeorm`
 * and would produce a duplicate-`DataSource` error. The adapter
 * is the source of truth for the `DataSource`.
 *
 * ## Why `static forRoot()` and no `forRootAsync`
 *
 * Mirroring `InProcessAdapter`, the factory is a static method
 * so the adapter can be referenced as a value (`adapters:
 * { persistence: TypeOrmAdapter.forRoot({...}) }`) without
 * needing an instance. `forRootAsync` (with a `useFactory` +
 * `inject` shape) is intentionally **not** provided in this
 * release: the `@nestjs/typeorm` package's own `forRootAsync`
 * API is the right call when the connection options come from a
 * config service, and consumers can wrap `TypeOrmModule.forRootAsync(...)`
 * in a thin custom factory if they need that. Adding a second
 * async variant on top of the standard one would just be a
 * re-skinned `useFactory` and would obscure the host's actual
 * async source.
 *
 * ## Why `globalProviders` includes the token bindings
 *
 * The `BatchAdapter` interface (see `@nest-batch/core`'s
 * `module/adapter.ts`) allows a `globalProviders` field for
 * runtime classes the adapter's own module needs to inject but
 * that the host app should also be able to inject. For the
 * TypeORM persistence adapter, the canonical binding points are
 * the `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 * symbols defined in `@nest-batch/core`. We list them in
 * `globalProviders` for two reasons:
 *
 *   1. The core engine (`JobExecutor`, `ChunkStepExecutor`,
 *      `TaskletStepExecutor`, ...) injects the repository and
 *      transaction manager by these tokens. When T2 wires up
 *      `NestBatchModule.forRoot({ adapters })` to import this
 *      module and merge `globalProviders` into its own DI scope,
 *      the engine's `@Inject(JOB_REPOSITORY_TOKEN)` decorators
 *      resolve to the bound `TypeOrmJobRepository` instance.
 *   2. Host code that wants to inspect or wrap the persistence
 *      layer (e.g. a custom listener that reads the current
 *      `JobExecution` row) can inject either token directly.
 *      Without `globalProviders`, the binding would be hidden
 *      behind the adapter's module encapsulation and would not
 *      be visible outside the adapter's own module.
 *
 * The two implementation classes are also listed in the
 * module's own `providers` (as the underlying target of the
 * `useExisting` token bindings), and the two symbol tokens are
 * the module's `exports`. The concrete classes are reachable
 * via the `useExisting` chain, so we do not need to re-export
 * them — same shape as the T5 `MikroOrmAdapter`.
 *
 * ## Bring-your-own `DataSource`
 *
 * This adapter takes the **self-contained** shape: it builds the
 * `DataSource` for the host. The previous README
 * (`packages/typeorm/README.md`) describes a "bring your own
 * `DataSource`" alternative where the host configures
 * `TypeOrmModule.forRoot()` itself and passes a `DataSource`
 * instance to the module. That shape is **deliberately not
 * exposed** through this factory because:
 *
 *   - `@nestjs/typeorm` does not support two `forRoot()` calls
 *     in the same app — registering the `DataSource` twice
 *     produces a duplicate provider error.
 *   - The factory-pattern API is meant to be one-call-per-slot;
 *     a "BYO DataSource" shape would require the host to wire
 *     `TypeOrmJobRepository` / `TypeOrmTransactionManager` by
 *     hand and would defeat the "self-contained adapter"
 *     point.
 *
 * Hosts that already configure `TypeOrmModule.forRoot()` with
 * their own entities and migrations should pass the same
 * `TypeOrmModuleOptions` to `TypeOrmAdapter.forRoot({...})` —
 * the adapter accepts the full `DataSourceOptions` shape, so
 * nothing is lost in translation.
 *
 * ## DB-first semantics
 *
 * The repository is the durable source of truth for execution
 * state. The `createExecutionAtomic` flow uses
 * `SELECT ... FOR UPDATE SKIP LOCKED` (via TypeORM's
 * `pessimistic_write` + `skip_locked`) to serialize concurrent
 * launches; `findLatestStepExecution` orders by `created_at`
 * (insertion timestamp) descending, since the v4 UUID primary
 * key does not preserve insertion order. Both behaviours are
 * documented on `TypeOrmJobRepository`.
 */
export class TypeOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * The method is static so the adapter can be referenced as a
   * value without needing an instance, mirroring
   * `InProcessAdapter.forRoot()` in `@nest-batch/core` and
   * `MikroOrmAdapter.forRoot()` in `@nest-batch/mikro-orm`.
   *
   * @param options - the TypeORM `DataSourceOptions` shape, with
   *   the host's user-domain entities in the optional `entities`
   *   list. The batch meta entities are appended automatically.
   * @returns A `BatchAdapter` whose `module` is a `DynamicModule`
   *   that calls `TypeOrmModule.forRoot(...)` with the merged
   *   options, and whose `globalProviders` bind
   *   `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` to
   *   the TypeORM-backed implementations.
   */
  static forRoot(options: TypeOrmAdapterOptions): BatchAdapter {
    const merged = mergeEntities(options);
    return {
      name: 'typeorm',
      module: buildTypeOrmDynamicModule(merged),
      globalProviders: buildGlobalProviders(),
    };
  }
}

/**
 * Merge the host's user-domain entities with the batch meta
 * entities owned by this package.
 *
 * The host's entities come first in the spread so the package's
 * tables cannot be silently shadowed by a same-named host
 * entity — the batch meta tables are *always* registered last.
 * (This is a defence-in-depth measure; the six `batch_*` table
 * names are reserved by convention and should not collide.)
 *
 * The result is cast to `TypeOrmModuleOptions` for two reasons:
 *
 *   1. `EntityTarget<unknown>` is broader than TypeORM's
 *      `MixedList<string | Function | EntitySchema<...>>` target
 *      (the `EntityTarget` union includes the `{ name; type }`
 *      object form, which is not a valid `MixedList` element).
 *      At runtime every value is an entity class (a `Function`),
 *      so the cast is safe.
 *   2. The spread of a `TypeOrmAdapterOptions` object loses the
 *      discriminated-union narrowing on the `type` field
 *      (e.g. `'postgres'` vs `'mysql'`); re-asserting the
 *      `TypeOrmModuleOptions` type restores the contract the
 *      `@nestjs/typeorm` API expects.
 *
 * @internal
 */
function mergeEntities(options: TypeOrmAdapterOptions): TypeOrmModuleOptions {
  const entities = [
    ...(options.entities ?? []),
    ...BATCH_META_ENTITIES,
  ] as TypeOrmModuleOptions['entities'] & unknown[];
  return {
    ...options,
    entities,
  } as TypeOrmModuleOptions;
}

/**
 * Build the `DynamicModule` payload for the TypeORM persistence
 * transport.
 *
 * The module:
 *   1. `module` is the dedicated `TypeOrmBatchModule` empty
 *      class (cannot reuse `TypeOrmModule` — it has its own
 *      `forRoot()` factory and a second config for the same
 *      class would collide).
 *   2. `global: true` — the `JOB_REPOSITORY_TOKEN` /
 *      `TRANSACTION_MANAGER_TOKEN` bindings are visible at the
 *      host application level, not just inside the adapter's
 *      own module. Mirrors `NestBatchModule`'s own `global: true`,
 *      `InProcessAdapter`'s `global: true`, and the T5
 *      `MikroOrmAdapter` precedent.
 *   3. `imports` `TypeOrmModule.forRoot(merged)` so the
 *      `DataSource` (and the per-request `EntityManager` it
 *      exposes) is available for injection.
 *   4. `providers` the two implementation classes plus the two
 *      canonical-symbol token bindings. The token bindings use
 *      `useExisting` (not `useClass`) so the symbol and the
 *      concrete class resolve to the **same** instance — same
 *      pattern as `MikroOrmAdapter`.
 *   5. `exports` the two symbol tokens. Other modules that
 *      import this adapter can resolve the bindings by symbol;
 *      the concrete classes are reachable via the symbols
 *      (`useExisting` chains to them) so we do not need to
 *      re-export the classes themselves.
 *
 * @internal
 */
function buildTypeOrmDynamicModule(
  merged: TypeOrmModuleOptions,
): DynamicModule {
  return {
    module: TypeOrmBatchModule,
    global: true,
    imports: [TypeOrmModule.forRoot(merged)],
    providers: [
      TypeOrmJobRepository,
      TypeOrmTransactionManager,
      {
        provide: JOB_REPOSITORY_TOKEN,
        useExisting: TypeOrmJobRepository,
      },
      {
        provide: TRANSACTION_MANAGER_TOKEN,
        useExisting: TypeOrmTransactionManager,
      },
    ],
    exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
  };
}

/**
 * Build the `globalProviders` list core will register in its
 * own DI scope and re-export.
 *
 * Same shape as the module's own `providers` token bindings
 * (without the class entries — classes are visible to the host
 * via the module's `exports`). Listing the token bindings here
 * is what makes `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN`
 * resolvable from the host's `AppModule` and from core's engine
 * subgraph (`JobExecutor`, `ChunkStepExecutor`, ...) once T2's
 * `forRoot` body merges `globalProviders` into
 * `NestBatchModule`'s provider list.
 *
 * @internal
 */
function buildGlobalProviders(): readonly Provider[] {
  return [
    { provide: JOB_REPOSITORY_TOKEN, useClass: TypeOrmJobRepository },
    { provide: TRANSACTION_MANAGER_TOKEN, useClass: TypeOrmTransactionManager },
  ];
}
