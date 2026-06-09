// Public API barrel for `@nest-batch/postgresql`.
//
// This package is the **PostgreSQL driver sibling**. It owns the
// 4 Postgres adapter shells (MikroOrmPostgres, TypeOrmPostgres,
// DrizzlePostgres, PrismaPostgres), the bundled Postgres DDL
// migration, the Postgres Prisma schema, the Postgres-specific
// Drizzle schema carrier (`drizzle-schema.postgres.ts`), and
// the Postgres-specific MikroORM entity classes
// (`job-meta-entities.postgres.ts`).
//
// Apps wire the persistence concern into
// `NestBatchModule.forRoot()` via the `BatchAdapter` factory
// pattern:
//
//   import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
//   import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
//   import { MikroOrmPostgres, BATCH_META_ENTITIES } from '@nest-batch/postgresql';
//
//   MikroOrmModule.forRoot({
//     entities: [/* host entities */, ...BATCH_META_ENTITIES],
//     // ...
//     driver: PostgreSqlDriver,
//   });
//   NestBatchModule.forRoot({
//     adapters: {
//       persistence: MikroOrmAdapter.forRoot(),
//       transport: InProcessAdapter.forRoot(),
//     },
//   });
//
// The `BATCH_META_ENTITIES` tuple is the canonical list of batch
// meta tables registered with the host's metadata system. Spread
// it into the host's MikroORM `entities` array, Drizzle schema
// config, or Prisma `schema.prisma` include list, and the batch
// meta tables are wired in. The shape is the Spring Batch
// meta-schema with one intentional omission:
// `batch_job_execution_params` is dropped (its content is
// derivable from the parent job execution params + step
// execution context).
export { BATCH_META_ENTITIES } from './job-meta-entities.postgres';
