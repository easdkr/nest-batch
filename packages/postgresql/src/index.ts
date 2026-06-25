// Public API barrel for `@nest-batch/postgresql`.
//
// This package is the **PostgreSQL driver sibling**. It owns the
// 4 Postgres adapter shells (MikroORM Postgres, TypeORM Postgres,
// Drizzle Postgres, Prisma Postgres), Postgres runtime binding
// code, and the Postgres driver peer dependencies. Migration files
// live with the ORM package whose runner consumes them.
//
// Apps wire the persistence concern into
// `NestBatchModule.forRoot()` via the `BatchAdapter` factory
// pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
//   import { PostgresMikroOrmAdapter } from '@nest-batch/postgresql';
//
//   MikroOrmModule.forRoot({
//     entities: [/* host entities */, ...BATCH_META_ENTITIES],
//     // ...
//     driver: PostgreSqlDriver,
//   });
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresMikroOrmAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// MikroORM entity classes are owned and exported by
// `@nest-batch/mikro-orm`; this package only exports the Postgres
// shell and runtime binding.

// MikroORM Postgres shell
export { PostgresMikroOrmAdapter } from './mikroorm/postgres-mikroorm.adapter';
export { PostgresMikroOrmJobRepository } from './mikroorm/postgres-mikroorm-job-repository';
export {
  PostgresMikroOrmTransactionManager,
  type PostgresMikroOrmTransactionContext,
} from './mikroorm/postgres-mikroorm-transaction-manager';
export { PostgresMikroOrmBatchModule } from './mikroorm/postgres-mikroorm.module';

// TypeORM Postgres shell
export { PostgresTypeOrmAdapter } from './typeorm/postgres-typeorm.adapter';
export { PostgresTypeOrmJobRepository } from './typeorm/postgres-typeorm-job-repository';
export {
  PostgresTypeOrmTransactionManager,
  type PostgresTypeOrmTransactionContext,
} from './typeorm/postgres-typeorm-transaction-manager';
export { PostgresTypeOrmBatchModule } from './typeorm/postgres-typeorm.module';

// Drizzle Postgres shell
export { PostgresDrizzleAdapter } from './drizzle/postgres-drizzle.adapter';
export * as postgresDrizzleSchema from './drizzle-schema.postgres';
export { PostgresDrizzleJobRepository } from './drizzle/postgres-drizzle-job-repository';
export {
  PostgresDrizzleTransactionManager,
  type PostgresDrizzleTransactionContext,
} from './drizzle/postgres-drizzle-transaction-manager';
export { PostgresDrizzleBatchModule } from './drizzle/postgres-drizzle.module';

// Prisma Postgres shell
export { PostgresPrismaAdapter } from './prisma/postgres-prisma.adapter';
export { PostgresPrismaJobRepository } from './prisma/postgres-prisma-job-repository';
export {
  PostgresPrismaTransactionManager,
  type PostgresPrismaTransactionContext,
} from './prisma/postgres-prisma-transaction-manager';
export { PostgresPrismaBatchModule } from './prisma/postgres-prisma.module';
