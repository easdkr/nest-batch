// Public API barrel for @nest-batch/mikro-orm.
//
// This package is a **driver-agnostic adapter SLOT**. It owns the
// `MikroOrmAdapter` factory, the `MikroORMJobRepository` /
// `MikroORMTransactionManager` interface shape, and the
// `MikroOrmDriverProvider` injection token. It does NOT import
// `@mikro-orm/postgresql` (or any other driver) — the driver
// implementation lives in the `@nest-batch/postgresql` (or
// `@nest-batch/mysql`) sibling package, which binds the
// `MikroOrmDriverProvider` token to the concrete `EntityManager`
// in its own `forRoot()` factory.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
//   import { PostgresAdapter } from '@nest-batch/postgresql';
//
//   // The host must also call
//   // `MikroOrmModule.forRoot({ ... })` in their `AppModule.imports`.
//   // The PostgresAdapter.forRoot() factory binds the
//   // MikroOrmDriverProvider token to the host's EntityManager.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// The original `BATCH_META_ENTITIES` constant and the bundled
// migrations moved to `@nest-batch/postgresql/src/entities/`. The
// driver sibling owns the Postgres-specific entity classes and the
// migration scripts; this package owns only the repository /
// transaction manager shape and the driver-provider token.
export * from './mikroorm-job-repository';
export * from './mikroorm-transaction-manager';
export * from './adapters';
export * from './mikro-orm.driver-provider';
