// Public API barrel for @nest-batch/prisma.
//
// This package owns the Prisma adapter slot: the `PrismaAdapter`
// factory, the `PrismaJobRepository` / `PrismaTransactionManager`
// implementations, and the `PrismaDriverProvider` injection token.
// Apps add the documented batch meta models to their own Prisma
// schema and own the generated client plus migrations.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { PrismaAdapter } from '@nest-batch/prisma';
//   import { PostgresAdapter } from '@nest-batch/postgresql';
//
//   // The host must also instantiate a `PrismaClient` generated
//   // against the app-owned schema that includes the batch meta
//   // models documented in this package README.
//   // The PostgresAdapter.forRoot() factory binds the
//   // PrismaDriverProvider token to the host's PrismaClient.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
export { PrismaJobRepository } from './repository/prisma-job-repository';
export {
  PrismaTransactionManager,
  type PrismaTransactionContext,
} from './transaction/prisma-transaction-manager';
export * from './adapters';
export { PrismaBatchModule } from './prisma.module';
export * from './prisma.driver-provider';
