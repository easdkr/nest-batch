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
// The TypeORM entity tuple stays in this package because it is the
// schema contract consumed by a host-owned TypeORM DataSource. Apps
// generate and own their runnable migration files in their own
// migration workflow. Driver siblings bind the
// `TypeOrmDriverProvider` token to a concrete database connection.
import { BATCH_META_ENTITIES } from './entities';

export { TypeOrmJobRepository } from './repository/typeorm-job-repository';
export type { TypeOrmTransactionContext } from './transaction/typeorm-transaction-manager';
export { TypeOrmTransactionManager } from './transaction/typeorm-transaction-manager';
export * from './adapters';
export { BATCH_META_ENTITIES } from './entities';
export * from './typeorm.driver-provider';

export const batchMetaEntities = (): typeof BATCH_META_ENTITIES => BATCH_META_ENTITIES;
