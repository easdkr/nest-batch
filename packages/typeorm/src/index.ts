// Public API barrel for @nest-batch/typeorm.
//
// The package is a **driver-agnostic adapter SLOT**. It owns the
// `TypeOrmAdapter` factory, the `TypeOrmJobRepository` /
// `TypeOrmTransactionManager` interface shape, and the
// `TypeOrmDriverProvider` injection token. It does NOT import
// `@nestjs/typeorm` (which carries the Postgres driver) — the
// driver implementation lives in the `@nest-batch/postgresql` (or
// `@nest-batch/mysql`) sibling package, which binds the
// `TypeOrmDriverProvider` token to the concrete `DataSource`
// in its own `forRoot()` factory.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { TypeOrmAdapter } from '@nest-batch/typeorm';
//   import { PostgresAdapter } from '@nest-batch/postgresql';
//
//   // The host must also call
//   // `TypeOrmModule.forRoot({ ... })` in their `AppModule.imports`.
//   // The PostgresAdapter.forRoot() factory binds the
//   // TypeOrmDriverProvider token to the host's DataSource.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// The original `batchMetaEntities()` factory and the bundled
// `CreateBatchMeta1700000000000` migration moved to
// `@nest-batch/postgresql/src/migrations/`. The driver sibling owns
// the TypeORM-specific entity classes and the migration scripts;
// this package owns only the repository / transaction manager
// shape and the driver-provider token.
export { TypeOrmJobRepository } from './repository/typeorm-job-repository';
export type { TypeOrmTransactionContext } from './transaction/typeorm-transaction-manager';
export { TypeOrmTransactionManager } from './transaction/typeorm-transaction-manager';
export * from './adapters';
export * from './typeorm.driver-provider';
