// Public API barrel for @nest-batch/mysql.
//
// This package owns the 4 MySQL adapter shells (MikroORM MySQL,
// TypeORM MySQL, Drizzle MySQL, Prisma MySQL), the 6-table MySQL DDL
// migration, the bundled MySQL Prisma schema, and the shared
// test-contracts e2e harness against a real MySQL 8.x testcontainer.
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

// MySQL DDL migration (TypeORM 1.0.0 migration class, applies the
// six meta tables to a MySQL 8.x database).
export {
  CreateBatchMetaMysql1700000000001,
} from './migrations/1700000000001-CreateBatchMetaMysql';
