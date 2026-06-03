// Public API barrel for @nest-batch/mikro-orm.
//
// This package owns the Spring Batch-compatible batch meta-schema
// (entities, migrations) and the MikroORM-backed
// `JobRepository` / `TransactionManager` implementations that satisfy
// the contract suite exported by `@nest-batch/core`.
//
// Apps register the implementation as their `JobRepository` and
// `TransactionManager` provider — either directly:
//   providers: [
//     { provide: JobRepository, useClass: MikroORMJobRepository },
//     { provide: TransactionManager, useClass: MikroORMTransactionManager },
//   ]
// or via `NestBatchModule.forRoot({ repository, transactionManager })`.
export * from './entities/job-meta.entities';
export * from './mikroorm-job-repository';
export * from './mikroorm-transaction-manager';
export * from './nest-batch-mikro-orm.module';
export * from './mikro-orm.config';
