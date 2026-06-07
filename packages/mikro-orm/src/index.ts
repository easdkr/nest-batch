// Public API barrel for @nest-batch/mikro-orm.
//
// This package owns the Spring Batch-compatible batch meta-schema
// (entities, migrations) and the MikroORM-backed
// `JobRepository` / `TransactionManager` implementations that satisfy
// the contract suite exported by `@nest-batch/core`.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
//
//   // The host must also call
//   // `MikroOrmModule.forRoot({ entities: [..., ...BATCH_META_ENTITIES], ... })`
//   // in their `AppModule.imports` (BATCH_META_ENTITIES is the six-table
//   // batch meta-schema spread into the MikroORM entities array).
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: MikroOrmAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// Apps that need to compose a `MikroOrmModule` manually (e.g. they
// already configure one with user-domain entities) can still reach
// for the lower-level building blocks: `BATCH_META_ENTITIES` (the
// six entity classes to spread into `entities`),
// `MikroORMJobRepository` / `MikroORMTransactionManager` (the
// concrete provider classes), and `createBatchMikroOrmConfig` (a
// helper that builds a MikroORM config with the migrator pointed at
// the package's `src/migrations/`).
export * from './entities/job-meta.entities';
export * from './mikroorm-job-repository';
export * from './mikroorm-transaction-manager';
export * from './adapters';
export * from './mikro-orm.config';
