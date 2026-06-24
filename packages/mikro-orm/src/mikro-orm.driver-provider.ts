/**
 * `MikroOrmDriverProvider` — the abstract injection token the
 * `MikroOrmAdapter` and driver sibling packages bind to the host
 * `EntityManager` / `SqlEntityManager` type for the chosen database.
 *
 * This package (`@nest-batch/mikro-orm`) is **driver-agnostic**: it
 * does not import `@mikro-orm/postgresql` (Postgres) or
 * `@mikro-orm/mysql` (MySQL) directly. Instead, it exports the
 * `MikroOrmDriverProvider` symbol as a `Provider` token; adapter
 * factories bind the token to the `EntityManager` provided by the
 * host's `MikroOrmModule.forRoot(...)`.
 *
 * The `MikroORMJobRepository` / `MikroORMTransactionManager` classes
 * inject the token via the standard `@Inject(MikroOrmDriverProvider)`
 * decorator and cast the resolved value to the host-owned
 * `EntityManager` shape. This mirrors the
 * `@nestjs/typeorm` / `@nestjs/mikro-orm` pattern of "host owns the
 * connection, adapter owns the repository".
 *
 * Usage (in a host app, wired with `@nest-batch/postgresql`):
 *
 *   import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
 *   import { PostgresAdapter } from '@nest-batch/postgresql';
 *
 *   @Module({
 *     imports: [
 *       MikroOrmModule.forRoot({ ... }),
 *       NestBatchModule.forRoot({
 *         adapters: {
 *           persistence: PostgresAdapter.forRoot(), // binds the driver token
 *           transport: InProcessAdapter.forRoot(),
 *         },
 *       }),
 *     ],
 *   })
 *   class AppModule {}
 *
 * `MikroOrmAdapter.forRoot()` and the driver shell factories include
 * a provider that binds `MikroOrmDriverProvider` to the host's
 * `EntityManager`. The adapter slot (`@nest-batch/mikro-orm`) owns the
 * repository implementation; the host owns the actual `EntityManager`
 * instance.
 */
export const MikroOrmDriverProvider: symbol = Symbol.for(
  '@nest-batch/mikro-orm/MikroOrmDriverProvider',
);
