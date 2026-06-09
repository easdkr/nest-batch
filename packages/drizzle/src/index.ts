// Public API barrel for @nest-batch/drizzle.
//
// This package is a **driver-agnostic adapter SLOT**. It owns the
// `DrizzleAdapter` factory, the `DrizzleJobRepository` /
// `DrizzleTransactionManager` interface shape, and the
// `DrizzleDriverProvider` injection token. It does NOT import
// `drizzle-orm/pg-core` (Postgres), `drizzle-orm/node-postgres`,
// or `drizzle-orm/mysql-core` / `drizzle-orm/mysql2` (MySQL) —
// those live in the `@nest-batch/postgresql` (or future
// `@nest-batch/mysql`) sibling package, which binds the
// `DrizzleDriverProvider` token to the concrete Drizzle `Database`
// in its own `forRoot()` factory.
//
// Apps wire the persistence concern into `NestBatchModule.forRoot()`
// via the new `BatchAdapter` factory pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { DrizzleAdapter } from '@nest-batch/drizzle';
//   import { PostgresAdapter } from '@nest-batch/postgresql';
//
//   // The host must also provide a Drizzle Database (e.g. via
//   // `drizzle-orm/node-postgres`) in their providers. The
//   // PostgresAdapter.forRoot() factory binds the
//   // DrizzleDriverProvider token to the host's Drizzle Database.
//
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: PostgresAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// The original `schema.ts` (the `pgTable` definitions) moved to
// `@nest-batch/postgresql/src/drizzle-schema.postgres.ts`. The
// driver sibling owns the schema definitions; this package owns
// only the repository / transaction manager shape and the
// driver-provider token.
export { DrizzleJobRepository } from './repository/drizzle-job-repository';
export { DrizzleTransactionManager, type DrizzleTransactionContext } from './transaction/drizzle-transaction-manager';
export * from './adapters';
export { DrizzleBatchModule } from './drizzle.module';
export * from './drizzle.driver-provider';
