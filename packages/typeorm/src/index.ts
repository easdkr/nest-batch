// Public API barrel for @nest-batch/typeorm.
//
// The package owns the six Spring Batch-compatible batch meta
// tables, exposes TypeOrmJobRepository and TypeOrmTransactionManager,
// and ships the schema as a TypeORM migration so consumers can run
// `DataSource.runMigrations()` to bring up a clean database.
//
// This package targets TypeORM 1.0.0 only. The peer range is
// `^1.0.0` and intentionally excludes 0.3.x.
export * from './entities';
export { TypeOrmJobRepository, batchMetaEntities } from './repository/typeorm-job-repository';
export type { TypeOrmTransactionContext } from './transaction/typeorm-transaction-manager';
export { TypeOrmTransactionManager } from './transaction/typeorm-transaction-manager';
export { CreateBatchMeta1700000000000 } from './migrations/1700000000000-CreateBatchMeta';
export * from './adapters';
