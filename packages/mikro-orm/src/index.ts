// Public API barrel for @nest-batch/mikro-orm.
//
// This package is a **driver-agnostic adapter SLOT**. It owns the
// `MikroOrmAdapter` factory, the `MikroORMJobRepository` /
// `MikroORMTransactionManager` interface shape, and the
// `MikroOrmDriverProvider` injection token. It does NOT import
// `@mikro-orm/postgresql` (or any other driver) — the host owns
// `MikroOrmModule.forRoot(...)`, and the adapter aliases
// `MikroOrmDriverProvider` to that host `EntityManager`.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
//   import { PostgresMikroOrmAdapter } from '@nest-batch/postgresql';
//   import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
//
//   // The host must also call
//   // `MikroOrmModule.forRoot({ entities: [...BATCH_META_ENTITIES] })`
//   // in their `AppModule.imports`.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresMikroOrmAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// `BATCH_META_ENTITIES` and the MikroORM entity classes live here
// because `MikroORMJobRepository` instantiates these class
// identities. Driver siblings own dialect-specific shells,
// migrations, schema carriers, and driver peer dependencies.
export * from './mikroorm-job-repository';
export * from './mikroorm-transaction-manager';
export * from './adapters';
export * from './mikro-orm.driver-provider';
export * from './entities/job-meta.entities';
