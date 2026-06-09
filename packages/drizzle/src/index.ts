// Public API barrel for @nest-batch/drizzle.
//
// This package owns the Spring Batch-compatible batch meta-schema
// (Drizzle schema) and the Drizzle-backed
// `JobRepository` / `TransactionManager` implementations that satisfy
// the contract suite exported by `@nest-batch/core`.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { DrizzleAdapter } from '@nest-batch/drizzle';
//
//   // The host must also provide the Drizzle NodePgDatabase in their providers
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: DrizzleAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
export * from './schema';
export { DrizzleJobRepository } from './repository/drizzle-job-repository';
export { DrizzleTransactionManager, type DrizzleTransactionContext } from './transaction/drizzle-transaction-manager';
export * from './adapters';
export { DrizzleBatchModule } from './drizzle.module';
