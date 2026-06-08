// Public API barrel for @nest-batch/prisma.
//
// This package owns the Spring Batch-compatible batch meta-schema
// (Prisma schema + migration) and the Prisma-backed
// `JobRepository` / `TransactionManager` implementations that satisfy
// the contract suite exported by `@nest-batch/core`.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { PrismaAdapter } from '@nest-batch/prisma';
//
//   // The host must also set up PrismaClient in their providers
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PrismaAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
export { PrismaJobRepository } from './repository/prisma-job-repository';
export { PrismaTransactionManager, type PrismaTransactionContext } from './transaction/prisma-transaction-manager';
export * from './adapters';
export { PrismaBatchModule } from './prisma.module';
