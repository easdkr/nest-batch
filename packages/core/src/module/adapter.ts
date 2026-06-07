/**
 * `BatchAdapter` — the type contract every sibling adapter package
 * implements to plug into `@nest-batch/core`.
 *
 * An adapter is a *self-contained* bundle of Nest providers for one of
 * the two concerns core delegates:
 *
 *   - `persistence` — the `JobRepository` + `TransactionManager`
 *     bindings plus the storage meta tables (e.g.
 *     `@nest-batch/mikro-orm`, `@nest-batch/typeorm`).
 *   - `transport`   — the `IExecutionStrategy` binding for a queue
 *     runtime plus the transport's lifecycle (workers, schedulers,
 *     event bridges — e.g. `@nest-batch/bullmq`).
 *
 * The two slots are required (the type encodes that), and core
 * imports both at module-build time — adapters never talk to each
 * other directly, they go through core.
 *
 * Shape contract:
 *
 *   - `name`             — a stable, human-readable identifier
 *     (`'mikro-orm'`, `'bullmq'`, ...). Used in logs, in the
 *     resolved options bag under `MODULE_OPTIONS_TOKEN`, and as the
 *     key for any per-adapter DI registration. Treat it as the
 *     package's public name; changing it is a breaking change.
 *
 *   - `module`           — a Nest `DynamicModule` that core will
 *     `import` as part of building `NestBatchModule`. The adapter
 *     owns the module — it can be a class with a static factory
 *     (e.g. `MikroOrmAdapter.forRoot({ ... })`) or a plain
 *     `DynamicModule` literal. Core treats it as opaque and only
 *     forwards it to the `imports` array. The adapter is responsible
 *     for the module being self-contained (its own `imports`,
 *     `providers`, and `exports`).
 *
 *   - `globalProviders`  — *optional* list of Nest `Provider` records
 *     core will register into its own DI scope and re-export. The
 *     use case is runtime classes (e.g. `JobExecutor`,
 *     `InProcessExecutionStrategy`) that the adapter's own module
 *     needs to inject but that the host app should also be able to
 *     inject. Without this re-export, Nest's module encapsulation
 *     hides those providers from anyone outside the adapter's
 *     module. If the adapter does not need any host-visible
 *     providers, omit the field — core treats `undefined` and `[]`
 *     identically.
 *
 * The adapter is *purely* a DI bundle. It does not run any code at
 * module-build time (other than what Nest does when it processes the
 * `DynamicModule`). Wiring, lifecycle, and runtime behaviour are
 * the adapter's responsibility — core's job is to import the
 * `module` and merge the `globalProviders` into its own provider
 * list.
 *
 * @example
 * ```ts
 * // packages/mikro-orm — typical persistence adapter
 * export class MikroOrmAdapter {
 *   static forRoot(): BatchAdapter {
 *     return {
 *       name: 'mikro-orm' as const,
 *       module: {
 *         module: MikroOrmBatchModule,
 *         global: true,
 *         providers: [MikroORMJobRepository, MikroORMTransactionManager],
 *         exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
 *       },
 *       globalProviders: [
 *         { provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository },
 *         { provide: TRANSACTION_MANAGER_TOKEN, useClass: MikroORMTransactionManager },
 *       ],
 *     };
 *   }
 * }
 * ```
 */
import type { DynamicModule, Provider } from '@nestjs/common';

/**
 * A single adapter bundle.
 *
 * See the {@link BatchAdapter} module-level JSDoc for the full
 * contract. The interface is closed (no `[key: string]: unknown`
 * index signature) because every adapter is a deliberate
 * implementation of one of the two well-known roles
 * (`persistence` / `transport`); sibling packages cannot extend it
 * with extra fields.
 */
export interface BatchAdapter {
  /** Stable identifier for the adapter (e.g. `'mikro-orm'`, `'bullmq'`). */
  readonly name: string;

  /**
   * The `DynamicModule` core will import when building
   * `NestBatchModule`. The adapter owns this module — it can be a
   * `forRoot({ ... })` result, a `forRootAsync({ ... })` result, or
   * a plain `DynamicModule` literal.
   */
  readonly module: DynamicModule;

  /**
   * Optional list of Nest `Provider` records core will register
   * into its own DI scope and re-export. Use this for runtime
   * classes the adapter's own module needs to inject but that the
   * host app should also be able to inject. Omit (or return `[]`)
   * when the adapter has no host-visible providers.
   */
  readonly globalProviders?: readonly Provider[];
}

/**
 * The full adapter configuration core requires to build a working
 * batch engine.
 *
 * Both keys are **required**: every deployment must pick one
 * persistence adapter and one transport adapter. There is no
 * implicit default — even the in-process transport ships as a
 * dedicated `BatchAdapter` (T4) so the choice is explicit at the
 * call site and the host's `AppModule` reads as a complete wiring
 * recipe.
 *
 * Why is the shape closed (`persistence` + `transport` and nothing
 * else) and not an open record?
 *   - The two slots are the only concerns core delegates. There is
 *     no third concern today, and adding one would be a breaking
 *     change by design.
 *   - A closed shape lets the compiler catch a missing adapter at
 *     `forRoot({ adapters: { ... } })` time — the host cannot
 *     accidentally boot a `NestBatchModule` without a persistence
 *     binding or a transport binding.
 *   - The `as const satisfies` pattern keeps the adapter's
 *     `name` narrowed to a literal type when the adapter defines
 *     it inline, which simplifies log filtering and config
 *     round-tripping.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     MikroOrmModule.forRoot({
 *       entities: [ProductEntity, ...BATCH_META_ENTITIES],
 *       dbName: process.env.DB_NAME,
 *       // ...host-owned MikroORM options
 *     }),
 *     NestBatchModule.forRoot({
 *       adapters: {
 *         persistence: MikroOrmAdapter.forRoot(),
 *         transport: InProcessAdapter.forRoot(),
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export type BatchAdaptersConfig = {
  /** Adapter that owns the `JobRepository` + `TransactionManager` bindings. */
  readonly persistence: BatchAdapter;
  /** Adapter that owns the `IExecutionStrategy` (transport) binding. */
  readonly transport: BatchAdapter;
};
