// Public API barrel for @nest-batch/prisma.
//
// This package is a **driver-agnostic adapter SLOT**. It owns the
// `PrismaAdapter` factory, the `PrismaJobRepository` /
// `PrismaTransactionManager` interface shape, and the
// `PrismaDriverProvider` injection token. It does NOT ship a
// `prisma/schema.prisma` (the Postgres schema moved to
// `@nest-batch/postgresql/prisma/schema.prisma`; the MySQL schema
// will ship in `@nest-batch/mysql/prisma/schema.prisma`).
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { PrismaAdapter } from '@nest-batch/prisma';
//   import { PostgresAdapter } from '@nest-batch/postgresql';
//
//   // The host must also instantiate a `PrismaClient` (generated
//   // against the bundled `@nest-batch/postgresql/prisma/schema.prisma`).
//   // The PostgresAdapter.forRoot() factory binds the
//   // PrismaDriverProvider token to the host's PrismaClient.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// The original `prisma/schema.prisma` and the bundled
// `prisma/migrations/` moved to `@nest-batch/postgresql/prisma/`.
export { PrismaJobRepository } from './repository/prisma-job-repository';
export { PrismaTransactionManager, type PrismaTransactionContext } from './transaction/prisma-transaction-manager';
export * from './adapters';
export { PrismaBatchModule } from './prisma.module';
export * from './prisma.driver-provider';
