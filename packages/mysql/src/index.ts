// Public API barrel for @nest-batch/mysql.
//
// This package owns the 4 MySQL adapter shells (MikroORM MySQL,
// TypeORM MySQL, Drizzle MySQL, Prisma MySQL), the 6-table MySQL DDL
// migration, the bundled MySQL Prisma schema, and the shared
// test-contracts e2e harness against a real MySQL 8.x testcontainer.
//
// The `BATCH_META_ENTITIES` tuple is the canonical list of batch
// meta tables registered with the host's metadata system. Spread
// it into the host's MikroORM `entities` array, Drizzle schema
// config, or Prisma `schema.prisma` include list, and the batch
// meta tables are wired in. The shape is the batch meta-schema
// with one intentional omission:
// `batch_job_execution_params` is dropped (its content is
// derivable from the parent job execution params + step
// execution context).
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { MysqlMikroOrmAdapter } from '@nest-batch/mysql';
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: MysqlMikroOrmAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// Or swap `MysqlMikroOrmAdapter` for `MysqlTypeOrmAdapter`,
// `MysqlDrizzleAdapter`, or `MysqlPrismaAdapter` — same shape, four
// driver-specific bindings.

// MikroORM MySQL shell
export {
  MysqlMikroOrmAdapter,
} from './mikroorm/mysql-mikroorm.adapter';
export {
  MysqlMikroOrmJobRepository,
} from './mikroorm/mysql-mikroorm-job-repository';
export type {
  MysqlEntityManager,
} from './mikroorm/mysql-mikroorm-job-repository';
export {
  MysqlMikroOrmTransactionManager,
  type MysqlMikroOrmTransactionContext,
} from './mikroorm/mysql-mikroorm-transaction-manager';
export {
  MysqlMikroOrmBatchModule,
} from './mikroorm/mysql-mikroorm.module';

// TypeORM MySQL shell
export {
  MysqlTypeOrmAdapter,
} from './typeorm/mysql-typeorm.adapter';
export {
  MysqlTypeOrmJobRepository,
} from './typeorm/mysql-typeorm-job-repository';
export {
  MysqlTypeOrmTransactionManager,
  type MysqlTypeOrmTransactionContext,
} from './typeorm/mysql-typeorm-transaction-manager';
export {
  MysqlTypeOrmBatchModule,
} from './typeorm/mysql-typeorm.module';

// Drizzle MySQL shell
export {
  MysqlDrizzleAdapter,
} from './drizzle/mysql-drizzle.adapter';
export * as mysqlDrizzleSchema from './drizzle/schema';
export {
  MysqlDrizzleJobRepository,
} from './drizzle/mysql-drizzle-job-repository';
export {
  MysqlDrizzleTransactionManager,
  type MysqlDrizzleTransactionContext,
} from './drizzle/mysql-drizzle-transaction-manager';
export {
  MysqlDrizzleBatchModule,
} from './drizzle/mysql-drizzle.module';

// Prisma MySQL shell
export {
  MysqlPrismaAdapter,
} from './prisma/mysql-prisma.adapter';
export {
  MysqlPrismaJobRepository,
} from './prisma/mysql-prisma-job-repository';
export {
  MysqlPrismaTransactionManager,
  type MysqlPrismaTransactionContext,
} from './prisma/mysql-prisma-transaction-manager';
export {
  MysqlPrismaBatchModule,
} from './prisma/mysql-prisma.module';

// MySQL batch meta-entities (MikroORM `Entity` classes + the
// `BATCH_META_ENTITIES` tuple). The host spreads this into its
// `MikroOrmModule.forRoot({ entities: [...BATCH_META_ENTITIES] })`
// call so the 5 meta tables are wired in.
export {
  BATCH_META_ENTITIES,
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from './job-meta-entities.mysql';

// MySQL DDL migration (TypeORM 1.0.0 migration class, applies the
// six meta tables to a MySQL 8.x database).
export {
  CreateBatchMetaMysql1700000000001,
} from './migrations/1700000000001-CreateBatchMetaMysql';
