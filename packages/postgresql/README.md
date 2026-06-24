# `@nest-batch/postgresql`

PostgreSQL driver sibling for [`@nest-batch/core`](../core). Owns
the 4 Postgres adapter shells (`PostgresMikroOrmAdapter`,
`PostgresTypeOrmAdapter`, `PostgresDrizzleAdapter`,
`PostgresPrismaAdapter`), the bundled 5-table Postgres
DDL migration, and the Postgres-specific schema carriers
(Drizzle `pg-core` schema, Prisma `schema.prisma`). The package is
the **only** `@nest-batch/*` sibling that declares Postgres provider
peer dependencies (`pg`, `@mikro-orm/postgresql`,
`@nestjs/typeorm`, `drizzle-orm/pg-core`, `@prisma/client`).

> **This is the Postgres driver binding, not a replacement for the
> 4 ORM adapter packages.** `@nest-batch/mikro-orm`,
> `@nest-batch/typeorm`, `@nest-batch/drizzle`, and
> `@nest-batch/prisma` keep their names and their public API in
> 0.2.0; they became **driver-agnostic adapter slots**. The Postgres
> shell moves here so the user-imposed guardrail
> "DB adapters must not depend on a DB provider" can be enforced
> by a single boundary test in each slot. See
> [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.3 for
> the shaping context, and §2 for the lockstep 10-package table.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/postgresql  ──▶  @nest-batch/core
        │
        └──────▶  the 4 driver-agnostic adapter slot packages
                 (mikro-orm, typeorm, drizzle, prisma) — peer
        └──────▶  the 4 Postgres providers (pg, @mikro-orm/postgresql,
                 @nestjs/typeorm, drizzle-orm/pg-core, @prisma/client) — peer
```

`@nest-batch/core` does not know this package exists. It cannot.
The boundary is enforced by
[`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`](../core/tests/core/boundary/no-forbidden-imports.test.ts),
which scans the core source tree and fails the build if a forbidden
package — `pg`, `mysql2`, `drizzle-orm`, `prisma`, `@prisma/client`,
`@mikro-orm/*`, `typeorm`, `@nestjs/typeorm`, `kafkajs`, `bullmq`,
`cron` — appears as a core import.

Consequence: adding `pg` to this package's `peerDependencies` is
the only way for a host to get Postgres wiring against the
4 driver-agnostic slots. The 4 slot packages stay
`@nest-batch/core`-only, and the core module stays
dependency-light.

---

## Install

```bash
pnpm add @nest-batch/postgresql
```

This package is a **carrier**. The host gets it to install the
Postgres driver binding; the 4 ORM-specific adapter packages
(`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
`@nest-batch/drizzle`, `@nest-batch/prisma`) are also
peer-declared and must be installed alongside. A typical install
for a Postgres + Drizzle host looks like:

```bash
pnpm add @nest-batch/postgresql @nest-batch/drizzle \
         drizzle-orm pg @nestjs/common @nestjs/core
```

A typical install for a Postgres + MikroORM host:

```bash
pnpm add @nest-batch/postgresql @nest-batch/mikro-orm \
         @mikro-orm/core @mikro-orm/nestjs @mikro-orm/postgresql \
         @nestjs/common @nestjs/core
```

A typical install for a Postgres + TypeORM host:

```bash
pnpm add @nest-batch/postgresql @nest-batch/typeorm \
         typeorm @nestjs/typeorm pg \
         @nestjs/common @nestjs/core
```

A typical install for a Postgres + Prisma host:

```bash
pnpm add @nest-batch/postgresql @nest-batch/prisma \
         prisma @prisma/client \
         @nestjs/common @nestjs/core
```

---

## Peer dependencies

The host must already provide these (or install them alongside
this package). The full peer table:

| Package                 | Range          | Notes                                                                                                                                              |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nest-batch/core`      | `workspace:^`  | The batch engine. This package only extends its DI surface.                                                                                        |
| `@nest-batch/mikro-orm` | `workspace:^`  | The MikroORM adapter slot; this package exports its Postgres shell (`PostgresMikroOrmAdapter`).                                                    |
| `@nest-batch/typeorm`   | `workspace:^`  | The TypeORM adapter slot; this package exports its Postgres shell (`PostgresTypeOrmAdapter`).                                                      |
| `@nest-batch/drizzle`   | `workspace:^`  | The Drizzle adapter slot; this package exports its Postgres shell (`PostgresDrizzleAdapter`) plus the bundled `drizzle-schema.postgres.ts` schema. |
| `@nest-batch/prisma`    | `workspace:^`  | The Prisma adapter slot; this package exports its Postgres shell (`PostgresPrismaAdapter`) plus the bundled `prisma/schema.prisma`.                |
| `@nestjs/common`        | `^10 \|\| ^11` | For `@Module` / `Module` / injection tokens. Nest 10 and 11 are both supported.                                                                    |
| `pg`                    | `^8.11.0`      | The Postgres wire-protocol driver (used by the TypeORM shell and the e2e harness).                                                                 |
| `@mikro-orm/postgresql` | `^6.0.0`       | The MikroORM 6.x Postgres driver.                                                                                                                  |
| `@nestjs/typeorm`       | `^10 \|\| ^11` | NestJS-TypeORM bridge.                                                                                                                             |
| `typeorm`               | `^1.0.0`       | TypeORM 1.0.0 line (the first version with the stable driver slot API).                                                                            |
| `drizzle-orm`           | `^0.40.0`      | The Drizzle ORM core (the `pgTable` / `pg-core` factory imports).                                                                                  |
| `prisma`                | `^6.0.0`       | The Prisma CLI (for the bundled schema's `prisma migrate` flow).                                                                                   |
| `@prisma/client`        | `^6.0.0`       | The Prisma client runtime.                                                                                                                         |

The peer table is intentionally broad. A host that only uses one
of the 4 shells still has the other 3 listed in `peerDependencies`
because the package ships all 4 shell bindings. Pnpm hoists the
ones the host actually needs; the rest are no-ops at runtime.

---

## Wiring

This package ships 4 Postgres adapter shells, one per ORM. The
host picks the one that matches its chosen ORM. All 4 shells are
re-exported from `@nest-batch/postgresql`; the host's
`NestBatchModule.forRoot({ adapters: { persistence } })` slot
takes the corresponding Postgres shell adapter
(`PostgresMikroOrmAdapter`, `PostgresTypeOrmAdapter`,
`PostgresDrizzleAdapter`, `PostgresPrismaAdapter`).

### 1. MikroORM Postgres

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import { PostgresMikroOrmAdapter } from '@nest-batch/postgresql';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [/* ...host entities..., */ ...BATCH_META_ENTITIES],
      dbName: 'nest_batch_demo',
      // ... your existing MikroORM config
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: PostgresMikroOrmAdapter.forRoot(),
        // transport slot: BullmqAdapter / KafkaAdapter / InProcessAdapter
      },
    }),
  ],
})
export class AppModule {}
```

`PostgresMikroOrmAdapter` is a no-arg `BatchAdapter` shell. The
MikroORM entity classes and `BATCH_META_ENTITIES` tuple come from
`@nest-batch/mikro-orm`; this package provides the Postgres shell
and driver/schema carriers.

### 2. TypeORM Postgres

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NestBatchModule } from '@nest-batch/core';
import { PostgresTypeOrmAdapter } from '@nest-batch/postgresql';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      // ... your existing TypeORM config
    }),
    NestBatchModule.forRoot({
      adapters: { persistence: PostgresTypeOrmAdapter.forRoot() },
    }),
  ],
})
export class AppModule {}
```

### 3. Drizzle Postgres

```ts
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { PostgresDrizzleAdapter, postgresDrizzleSchema } from '@nest-batch/postgresql';

type Db = NodePgDatabase<typeof postgresDrizzleSchema>;

@Module({
  providers: [
    {
      provide: 'DB',
      useFactory: (): Db =>
        drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), {
          schema: postgresDrizzleSchema,
        }),
    },
  ],
  exports: ['DB'],
  imports: [
    NestBatchModule.forRoot({
      adapters: {
        persistence: PostgresDrizzleAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

The bundled `drizzle-schema.postgres.ts`
(`import { postgresDrizzleSchema } from '@nest-batch/postgresql'`)
provides the 5-table Drizzle schema
for Postgres (`batch_job_instance`, `batch_job_execution`,
`batch_step_execution`, `batch_job_execution_context`,
`batch_step_execution_context`).

### 4. Prisma Postgres

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { PostgresPrismaAdapter } from '@nest-batch/postgresql';

@Module({
  imports: [
    NestBatchModule.forRoot({
      adapters: { persistence: PostgresPrismaAdapter.forRoot() },
    }),
  ],
})
export class AppModule {}
```

The bundled `prisma/schema.prisma` (under `node_modules/@nest-batch/postgresql/prisma/`)
declares the 5 batch meta models with a `postgresql` provider;
the host points its `prisma generate` at the bundled schema and
inherits the meta tables. See `prisma/migrations/` for the
generated migration the bundled schema produces.

---

## Postgres 5-table migration

The 5-table active batch meta-schema ships as raw SQL
at `migrations/0001-create-batch-meta.sql`. It is the canonical
DDL for the package: every shell binding reads and writes the
same tables, and the column-type choices (PostgreSQL `timestamptz`,
`text`, `varchar(N)`, `int`) are locked in this file.

| Table                          | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `batch_job_instance`           | One row per logical job (unique on `job_name`+`job_key`).                          |
| `batch_job_execution`          | One row per job run. Holds status, start/end, exit code/message.                   |
| `batch_step_execution`         | One row per step run. Holds step status, exit code/message, last-chunk checkpoint. |
| `batch_job_execution_context`  | JSON checkpoint + execution context (job-scoped).                                  |
| `batch_step_execution_context` | JSON checkpoint + execution context (step-scoped).                                 |

(The 6th classic Spring Batch table, `batch_step_execution_params`,
is intentionally not shipped. Step params are derivable from the
parent job execution params plus the step execution context. The
active-execution unique index is also intentionally absent: the
`SELECT ... FOR UPDATE SKIP LOCKED` pattern in
`createExecutionAtomic` serializes concurrent launches without
the constraint's write-contention cost.)

A Drizzle-kit / TypeORM / Prisma migration equivalent
(`migrations/1700000000000-CreateBatchMeta.ts` and
`prisma/migrations/`) is also bundled. Pick the one that matches
your host's migration runner:

| Runner      | File                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| Raw SQL     | `migrations/0001-create-batch-meta.sql`                                     |
| Drizzle Kit | `migrations/1700000000000-CreateBatchMeta.ts`                               |
| Prisma      | `prisma/migrations/<timestamp>_create_batch_meta/migration.sql` (generated) |
| TypeORM CLI | The host copies the raw SQL into its own `migrations/` directory.           |

### Apply the raw SQL directly

```bash
psql "$DATABASE_URL" \
  -f node_modules/@nest-batch/postgresql/migrations/0001-create-batch-meta.sql
```

This is the recommended path for hosts that want a one-shot
setup. The file is `IF NOT EXISTS`-guarded and idempotent.

### Apply via Drizzle Kit

```ts
// drizzle.config.ts
import type { Config } from 'drizzle-kit';
export default {
  schema: './node_modules/@nest-batch/postgresql/src/drizzle-schema.postgres.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

```bash
pnpm drizzle-kit migrate
```

### Apply via Prisma

```bash
pnpm prisma migrate deploy \
  --schema node_modules/@nest-batch/postgresql/prisma/schema.prisma
```

---

## Tested with Postgres 14+

The package is tested against a real Postgres testcontainer
(`@testcontainers/postgresql`) in the e2e harness
(`tests/e2e/*.test.ts`). The pinned versions are
**Postgres 14, 15, 16, 17** — the four versions currently in
Postgres' active support window.

| Postgres version | Status        | Notes                                                                                                                                   |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 14               | Tested        | Oldest version in active support.                                                                                                       |
| 15               | Tested        | Default in `docker compose up -d postgres`.                                                                                             |
| 16               | Tested        |                                                                                                                                         |
| 17               | Tested        | Newest major.                                                                                                                           |
| 13               | Not supported | Outside the support window. The `timestamptz` and `text` columns are 13-compatible, but the boundary test pins the tested-version list. |
| 18               | Best-effort   | Should work; not in the CI matrix yet.                                                                                                  |

The e2e harness is **gated by `RUN_POSTGRES_E2E=1`** so the
default `pnpm test` run does not start a container. CI runs the
gated test against a fresh Postgres testcontainer per run.

```bash
# Default (no Docker required)
pnpm --filter @nest-batch/postgresql test

# E2E — requires Docker daemon and the env var
RUN_POSTGRES_E2E=1 pnpm --filter @nest-batch/postgresql test:e2e
```

---

## NOT a replacement for the 4 ORM adapter packages

This is the **user-imposed guardrail made explicit**. The
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
`@nest-batch/drizzle`, and `@nest-batch/prisma` packages keep
their names and their public API in 0.2.0. They became
**driver-agnostic adapter slots**; this package provides the
Postgres driver binding that pairs with them.

What this means in practice:

- The host continues to install the ORM adapter package it
  already depends on. `pnpm add @nest-batch/mikro-orm` (or
  `typeorm` / `drizzle` / `prisma`) is still the import path
  for the ORM-specific interface shape and the
  `XxxJobRepository` / `XxxTransactionManager` /
  `XxxAdapter` exports.
- The host additionally installs `@nest-batch/postgresql` to
  get the Postgres shell. The shell is a no-arg dynamic
  module that wires the Postgres provider into the
  ORM-specific adapter slot.
- The 4 ORM adapter packages do **not** declare
  `@mikro-orm/postgresql`, `@nestjs/typeorm`, `pg`, or
  `drizzle-orm/pg-core` as peer deps in 0.2.0. Those peers
  moved here. The boundary test in each slot fails the
  build if a Postgres provider leaks back in.
- The mirror package for MySQL is
  [`@nest-batch/mysql`](../mysql). A host that needs both
  Postgres and MySQL installs both sibling packages and the
  matching ORM slot(s).

If you are migrating from 0.1.0, the breaking change is
cosmetic: instead of `@nest-batch/mikro-orm` declaring
`@mikro-orm/postgresql` as a peer, the peer lives on
`@nest-batch/postgresql`. The `MikroOrmAdapter.forRoot()` /
`DrizzleAdapter.forRoot()` / `TypeOrmAdapter.forRoot()` /
`PrismaAdapter.forRoot()` call sites are unchanged.

See [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §2
for the lockstep 10-package table, and §3.3 for the
extraction rationale.

---

## What is NOT in this package

- A batch engine. The Job / Step / Chunk / Tasklet IR, decorators,
  and runtime live in [`@nest-batch/core`](../core). This package
  is a driver binding, not an engine.
- An ORM adapter. The 4 ORM adapter packages
  (`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
  `@nest-batch/drizzle`, `@nest-batch/prisma`) own the
  ORM-specific interface shape. This package only provides the
  Postgres driver binding.
- A MySQL driver. The MySQL mirror of this package is
  [`@nest-batch/mysql`](../mysql). The `mysql2` /
  `@mikro-orm/mysql` / `drizzle-orm/mysql-core` imports live
  there, behind the T-AC-2 boundary test.
- A transport. Use `@nest-batch/bullmq` or `@nest-batch/kafka`
  to wire an execution strategy. This package is persistence-
  only.
- A schema migration runner. The package ships the canonical
  SQL + Drizzle-kit / Prisma migration files, but the host
  picks the runner. Drizzle Kit, Prisma Migrate, raw `psql`,
  and TypeORM CLI are all supported.
- A SQLite driver. SQLite is on the 0.3.0 roadmap
  ([`@nest-batch/sqlite`](../../docs/RELEASE-0.2.0.md#91-sqlite-nest-batchsqlite)).
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. These are out of scope for the whole `@nest-batch/*`
  family. Hook a `BatchObserver` if you need to ship events
  somewhere.

---

## Scripts

```bash
pnpm --filter @nest-batch/postgresql build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/postgresql test       # vitest run (boundary; no Docker)
pnpm --filter @nest-batch/postgresql test:watch # vitest watch
pnpm --filter @nest-batch/postgresql test:e2e    # gated by RUN_POSTGRES_E2E=1
pnpm --filter @nest-batch/postgresql typecheck  # tsc --noEmit
```

The default `pnpm test` run is the boundary test
(`tests/boundary/`) which asserts that none of the forbidden
Postgres-specific imports (`pg`, `@mikro-orm/postgresql`,
`@nestjs/typeorm`, `typeorm`, `drizzle-orm/pg-core`,
`@prisma/client`) appear in the source trees of the 4
driver-agnostic adapter slots. The boundary test is the
canary for "Postgres did not leak into a slot". Run it
locally with:

```bash
pnpm --filter @nest-batch/postgresql test -- tests/boundary
```

The e2e test (`tests/e2e/`) requires a Docker daemon and is
gated by `RUN_POSTGRES_E2E=1`. The e2e harness brings up a
fresh Postgres 15 testcontainer, applies the 5-table
migration, runs the shared `@nest-batch/core` contract suite
against a real ORM binding, and tears the container down.
