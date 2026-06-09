# `@nest-batch/mysql`

MySQL driver sibling for [`@nest-batch/core`](../core). Owns the
4 MySQL adapter shells (`MysqlMikroOrmAdapter`,
`MysqlTypeOrmAdapter`, `MysqlDrizzleAdapter`,
`MysqlPrismaAdapter`), the bundled 6-table MySQL DDL migration,
and the MySQL-specific schema carriers (Drizzle `mysql-core`
schema, Prisma `schema.prisma` with `mysql` provider). The
package is the **only** `@nest-batch/*` sibling that declares
MySQL provider peer dependencies (`mysql2`,
`@mikro-orm/mysql`, `drizzle-orm/mysql-core`).

> **This is the MySQL driver binding, not a replacement for the
> 4 ORM adapter packages.** `@nest-batch/mikro-orm`,
> `@nest-batch/typeorm`, `@nest-batch/drizzle`, and
> `@nest-batch/prisma` keep their names and their public API in
> 0.2.0; they became **driver-agnostic adapter slots**. The MySQL
> shell moves here so the user-imposed guardrail
> "DB adapters must not depend on a DB provider" can be enforced
> by a single boundary test in each slot. See
> [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.3 for
> the shaping context, and §2 for the lockstep 10-package table.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/mysql  ──▶  @nest-batch/core
        │
        └──────▶  the 4 driver-agnostic adapter slot packages
                 (mikro-orm, typeorm, drizzle, prisma) — peer
        └──────▶  the 4 MySQL providers (mysql2, @mikro-orm/mysql,
                 drizzle-orm/mysql-core, @prisma/client) — peer
```

`@nest-batch/core` does not know this package exists. It cannot.
The boundary is enforced by
[`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`](../core/tests/core/boundary/no-forbidden-imports.test.ts),
which scans the core source tree and fails the build if a
forbidden package — `mysql2`, `pg`, `drizzle-orm`, `prisma`,
`@prisma/client`, `@mikro-orm/*`, `typeorm`, `@nestjs/typeorm`,
`kafkajs`, `bullmq`, `cron` — appears as a core import.

Consequence: adding `mysql2` to this package's
`peerDependencies` is the only way for a host to get MySQL wiring
against the 4 driver-agnostic slots. The 4 slot packages stay
`@nest-batch/core`-only, and the core module stays
dependency-light.

---

## Install

```bash
pnpm add @nest-batch/mysql
```

This package is a **carrier**. The host gets it to install the
MySQL driver binding; the 4 ORM-specific adapter packages
(`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
`@nest-batch/drizzle`, `@nest-batch/prisma`) are also
peer-declared and must be installed alongside. A typical install
for a MySQL + Drizzle host looks like:

```bash
pnpm add @nest-batch/mysql @nest-batch/drizzle \
         drizzle-orm mysql2 @nestjs/common @nestjs/core
```

A typical install for a MySQL + MikroORM host:

```bash
pnpm add @nest-batch/mysql @nest-batch/mikro-orm \
         @mikro-orm/core @mikro-orm/nestjs @mikro-orm/mysql \
         @nestjs/common @nestjs/core
```

A typical install for a MySQL + TypeORM host:

```bash
pnpm add @nest-batch/mysql @nest-batch/typeorm \
         typeorm @nestjs/typeorm mysql2 \
         @nestjs/common @nestjs/core
```

A typical install for a MySQL + Prisma host:

```bash
pnpm add @nest-batch/mysql @nest-batch/prisma \
         prisma @prisma/client \
         @nestjs/common @nestjs/core
```

---

## Peer dependencies

| Package                  | Range         | Notes                                                                                          |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| `@nest-batch/core`       | `workspace:^` | The batch engine. This package only extends its DI surface.                                    |
| `@nest-batch/mikro-orm`  | `workspace:^` | The MikroORM adapter slot; this package re-exports its MySQL shell (`MysqlMikroOrmAdapter` + `MysqlMikroOrmBatchModule`). |
| `@nest-batch/typeorm`    | `workspace:^` | The TypeORM adapter slot; this package re-exports its MySQL shell (`MysqlTypeOrmAdapter` + `MysqlTypeOrmBatchModule`). |
| `@nest-batch/drizzle`    | `workspace:^` | The Drizzle adapter slot; this package re-exports its MySQL shell (`MysqlDrizzleAdapter` + `MysqlDrizzleBatchModule`) plus the bundled `mysqlDrizzleSchema` namespace. |
| `@nest-batch/prisma`     | `workspace:^` | The Prisma adapter slot; this package re-exports its MySQL shell (`MysqlPrismaAdapter` + `MysqlPrismaBatchModule`). |
| `@nestjs/common`         | `^10 \|\| ^11`| For `@Module` / `Module` / injection tokens. Nest 10 and 11 are both supported.                |
| `mysql2`                 | `^3.0.0`      | The MySQL wire-protocol driver (used by the TypeORM shell and the e2e harness).               |
| `@mikro-orm/mysql`       | `^6.0.0`      | The MikroORM 6.x MySQL driver.                                                                 |
| `drizzle-orm`            | `^0.40.0`     | The Drizzle ORM core (the `mysqlTable` / `mysql-core` factory imports).                        |
| `prisma`                 | `^6.0.0`      | The Prisma CLI (for the bundled schema's `prisma migrate` flow).                              |
| `@prisma/client`         | `^6.0.0`      | The Prisma client runtime.                                                                      |

The peer table is intentionally broad. A host that only uses one
of the 4 shells still has the other 3 listed in
`peerDependencies` because the package ships all 4 shell
bindings. Pnpm hoists the ones the host actually needs; the rest
are no-ops at runtime.

---

## Wiring

Unlike the Postgres mirror (where each shell is a separate
dynamic module), the MySQL shells **replace** the ORM adapter in
the `NestBatchModule.forRoot({ adapters: { persistence } })`
slot. The host imports the `MysqlXxxAdapter` directly.

### 1. MikroORM MySQL

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import { MysqlMikroOrmAdapter } from '@nest-batch/mysql';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [/* ...host entities..., */ ...BATCH_META_ENTITIES],
      type: 'mysql',
      dbName: 'nest_batch_demo',
      // ... your existing MikroORM config
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MysqlMikroOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

`MysqlMikroOrmAdapter.forRoot()` is a no-arg `BatchAdapter`
factory. It declares the MySQL `EntityManager` binding the
MikroORM slot needs (`@mikro-orm/mysql` driver).

### 2. TypeORM MySQL

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { MysqlTypeOrmAdapter } from '@nest-batch/mysql';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      // ... your existing TypeORM config
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MysqlTypeOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

### 3. Drizzle MySQL

```ts
import { Module } from '@nestjs/common';
import { createPool } from 'mysql2/promise';
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { mysqlDrizzleSchema } from '@nest-batch/mysql';
import { MysqlDrizzleAdapter } from '@nest-batch/mysql';

type Db = MySql2Database<typeof mysqlDrizzleSchema>;

@Module({
  providers: [
    { provide: 'DB', useFactory: (): Db =>
      drizzle(createPool({ uri: process.env.DATABASE_URL }), { schema: mysqlDrizzleSchema, mode: 'default' }) },
  ],
  exports: ['DB'],
  imports: [
    NestBatchModule.forRoot({
      adapters: {
        persistence: MysqlDrizzleAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

The bundled `mysqlDrizzleSchema` namespace
(`import { mysqlDrizzleSchema } from '@nest-batch/mysql'`)
provides the 5-table Drizzle schema for MySQL
(`batch_job_instance`, `batch_job_execution`,
`batch_step_execution`, `batch_job_execution_context`,
`batch_step_execution_context`).

### 4. Prisma MySQL

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { MysqlPrismaAdapter } from '@nest-batch/mysql';

@Module({
  imports: [
    NestBatchModule.forRoot({
      adapters: {
        persistence: MysqlPrismaAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

The bundled `prisma/schema.prisma` declares the 5 batch meta
models with a `mysql` provider; the host points its
`prisma generate` at the bundled schema and inherits the meta
tables. See `prisma/migrations/20250101000000_init/` for the
generated migration the bundled schema produces.

---

## MySQL 6-table migration

The 6-table Spring Batch-compatible meta-schema ships as a
TypeORM 1.0.0 migration class at
`src/migrations/1700000000001-CreateBatchMetaMysql.ts` (re-exported
as `CreateBatchMetaMysql1700000000001`). The migration is the
canonical DDL for the package; the host wires it into its own
TypeORM / Prisma / Drizzle-kit migration runner.

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

The MySQL column-type choices are `VARCHAR(255)`, `TEXT`,
`DATETIME(6)` (microsecond precision), and `INT`. They map
symmetrically to the Postgres choices in
[`@nest-batch/postgresql`](../postgresql); a host migrating
between the two drivers gets the same row shape.

### Apply the TypeORM migration

```ts
// data-source.ts
import { DataSource } from 'typeorm';
import { CreateBatchMetaMysql1700000000001 } from '@nest-batch/mysql';

export default new DataSource({
  type: 'mysql',
  url: process.env.DATABASE_URL,
  entities: [/* ... */],
  migrations: [CreateBatchMetaMysql1700000000001],
});
```

```bash
pnpm typeorm-ts-node-commonjs migration:run -d data-source.ts
```

### Apply via Prisma

```bash
pnpm prisma migrate deploy \
  --schema node_modules/@nest-batch/mysql/prisma/schema.prisma
```

### Apply via Drizzle Kit

Point `drizzle.config.ts` at the bundled schema and run
`drizzle-kit migrate`. The bundled `src/drizzle/schema.ts`
re-exports the `mysqlTable` definitions; import them into your
host's drizzle config and run.

---

## Tested with MySQL 8.x

The package is tested against a real MySQL testcontainer
(`@testcontainers/mysql`) in the e2e harness
(`tests/e2e-mysql.test.ts`). The pinned version is
**MySQL 8.0 LTS** — the only MySQL major currently in Oracle's
active support window.

| MySQL version | Status         | Notes                                              |
| ------------- | -------------- | -------------------------------------------------- |
| 8.0 LTS       | Tested         | The MySQL 8.x line is the only supported major.    |
| 5.7           | Not supported  | Outside the support window. The `DATETIME(6)` and `JSON` column types used by the bundled schema are 5.7-compatible, but the boundary test pins the tested-version list. |
| 8.4 LTS       | Best-effort    | Should work; not in the CI matrix yet.             |
| 9.x           | Not supported  | No 9.x GA at the time of the 0.2.0 cut.            |
| MariaDB       | Not supported  | The bundled migrations target MySQL 8.0 syntax; MariaDB's `WITH` recursion and `JSON_TABLE` semantics diverge. |

The e2e harness is **gated by `RUN_MYSQL_E2E=1`** so the default
`pnpm test` run does not start a container. CI runs the gated
test against a fresh MySQL 8.0 testcontainer per run.

```bash
# Default (no Docker required)
pnpm --filter @nest-batch/mysql test

# E2E — requires Docker daemon and the env var
RUN_MYSQL_E2E=1 pnpm --filter @nest-batch/mysql test
```

---

## NOT a replacement for the 4 ORM adapter packages

This is the **user-imposed guardrail made explicit**. The
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
`@nest-batch/drizzle`, and `@nest-batch/prisma` packages keep
their names and their public API in 0.2.0. They became
**driver-agnostic adapter slots**; this package provides the
MySQL driver binding that pairs with them.

What this means in practice:

- The host continues to install the ORM adapter package it
  already depends on. `pnpm add @nest-batch/mikro-orm` (or
  `typeorm` / `drizzle` / `prisma`) is still the import path
  for the ORM-specific interface shape.
- The host additionally installs `@nest-batch/mysql` to get the
  MySQL shell. The shell is a `MysqlXxxAdapter.forRoot()` no-arg
  factory that wires the MySQL provider into the
  ORM-specific adapter slot.
- The 4 ORM adapter packages do **not** declare `mysql2`,
  `@mikro-orm/mysql`, or `drizzle-orm/mysql-core` as peer deps
  in 0.2.0. Those peers moved here. The boundary test in each
  slot fails the build if a MySQL provider leaks back in.
- The mirror package for Postgres is
  [`@nest-batch/postgresql`](../postgresql). A host that needs
  both Postgres and MySQL installs both sibling packages and
  the matching ORM slot(s).

If you are migrating from 0.1.0, the breaking change is
cosmetic: instead of `@nest-batch/mikro-orm` declaring
`@mikro-orm/mysql` as a peer, the peer lives on
`@nest-batch/mysql`. The `MysqlXxxAdapter.forRoot()` call sites
replace the previous in-slot `XxxAdapter.forRoot()` calls with
the MySQL-prefixed adapter; the rest of the wiring is unchanged.

See [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §2
for the lockstep 10-package table, and §3.3 for the extraction
rationale.

---

## What is NOT in this package

- A batch engine. The Job / Step / Chunk / Tasklet IR, decorators,
  and runtime live in [`@nest-batch/core`](../core). This package
  is a driver binding, not an engine.
- An ORM adapter. The 4 ORM adapter packages
  (`@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
  `@nest-batch/drizzle`, `@nest-batch/prisma`) own the
  ORM-specific interface shape. This package only provides the
  MySQL driver binding.
- A Postgres driver. The Postgres mirror of this package is
  [`@nest-batch/postgresql`](../postgresql). The `pg` /
  `@mikro-orm/postgresql` / `drizzle-orm/pg-core` imports live
  there, behind the T-AC-2b boundary test.
- A transport. Use `@nest-batch/bullmq` or `@nest-batch/kafka`
  to wire an execution strategy. This package is persistence-
  only.
- A schema migration runner. The package ships the canonical
  TypeORM migration class + Prisma migration files, but the
  host picks the runner. Drizzle Kit, Prisma Migrate, raw
  `mysql` client, and TypeORM CLI are all supported.
- A SQLite driver. SQLite is on the 0.3.0 roadmap
  ([`@nest-batch/sqlite`](../../docs/RELEASE-0.2.0.md#91-sqlite-nest-batchsqlite)).
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. These are out of scope for the whole `@nest-batch/*`
  family. Hook a `BatchObserver` if you need to ship events
  somewhere.

---

## Scripts

```bash
pnpm --filter @nest-batch/mysql build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/mysql test       # vitest run (boundary; no Docker)
pnpm --filter @nest-batch/mysql test:watch # vitest watch
pnpm --filter @nest-batch/mysql typecheck  # tsc --noEmit
```

The default `pnpm test` run is the boundary test
(`tests/boundary/`) which asserts that none of the forbidden
MySQL-specific imports (`mysql2`, `@mikro-orm/mysql`,
`drizzle-orm/mysql-core`, `@prisma/client`) appear in the
source trees of the 4 driver-agnostic adapter slots. The
boundary test is the canary for "MySQL did not leak into a
slot". Run it locally with:

```bash
pnpm --filter @nest-batch/mysql test -- tests/boundary
```

The e2e test (`tests/e2e-mysql.test.ts`) requires a Docker
daemon and is gated by `RUN_MYSQL_E2E=1`. The e2e harness brings
up a fresh MySQL 8.0 testcontainer, applies the 6-table
migration, runs the shared `@nest-batch/core` contract suite
against a real ORM binding, and tears the container down.
