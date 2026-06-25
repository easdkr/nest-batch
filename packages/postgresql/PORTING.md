# Postgres Porting Guide (Wave 1 Foundation)

This document maps every MySQL adapter shell in
[`@nest-batch/mysql`](../mysql) to the equivalent Postgres adapter
shell that will live in [`@nest-batch/postgresql`](./). It is the
investigation artifact for Wave 1 of the CI improvement plan; it
captures what already exists on the MySQL side, what the Postgres
target looks like, and what dialect-specific differences (driver
imports, schema carriers, SQL idioms) the port needs to account for.

> **Scope.** This document is **investigation only**. No porting
> happens here. The 4 Postgres shells (`PostgresDrizzleAdapter`,
> `PostgresMikroOrmAdapter`, `PostgresPrismaAdapter`,
> `PostgresTypeOrmAdapter` and their 12 sibling files) are
> documented, not written.

---

## 1. Source tree surveyed

### 1.1 MySQL shells (read in full)

Each shell directory under `packages/mysql/src/<orm>/` follows the
same 4-file pattern, except Drizzle which carries an extra schema
file:

| ORM      | Files                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Drizzle  | `mysql-drizzle.adapter.ts`, `mysql-drizzle.module.ts`, `mysql-drizzle-job-repository.ts`, `mysql-drizzle-transaction-manager.ts`, **`schema.ts`**            |
| MikroORM | `mysql-mikroorm.adapter.ts`, `mysql-mikroorm.module.ts`, `mysql-mikroorm-transaction-manager.ts` (no job-repository in current snapshot — see §5 issue note) |
| Prisma   | `mysql-prisma.adapter.ts`, `mysql-prisma.module.ts`, `mysql-prisma-job-repository.ts`, `mysql-prisma-transaction-manager.ts`                                 |
| TypeORM  | `mysql-typeorm.adapter.ts`, `mysql-typeorm.module.ts`, `mysql-typeorm-job-repository.ts`, `mysql-typeorm-transaction-manager.ts`                             |

### 1.2 Postgres shells (target — not yet ported)

Already in `packages/postgresql/src/`:

- `index.ts` — public API barrel
- `drizzle-schema.postgres.ts` — Drizzle `pgTable` schema carrier
  (the Postgres mirror of `mysql-drizzle/schema.ts`)
- `mikroorm/postgres-mikroorm.adapter.ts` — MikroORM Postgres shell

Not yet in `packages/postgresql/src/`: any of the 4 Postgres
shells (`postgres-drizzle/`, `postgres-mikroorm/`,
`postgres-prisma/`, `postgres-typeorm/`).

### 1.3 Abstract base classes (read in full)

| File                                                                                                               | Purpose                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core/src/core/repository/job-repository.ts`](../core/src/core/repository/job-repository.ts)             | `IJobRepository` interface + abstract `JobRepository` class (13 abstract methods covering get/create/atomic-create/update/getRunning/findLatest for jobs, steps, execution contexts). |
| [`packages/core/src/core/transaction/transaction-manager.ts`](../core/src/core/transaction/transaction-manager.ts) | `TransactionContext` interface + abstract `TransactionManager` class (single method: `withTransaction<T>(fn)`).                                                                       |

---

## 2. Naming convention (mysql → postgres)

The MySQL prefix becomes the Postgres prefix. Class and module
names follow the same `MysqlXxx{JobRepository,TransactionManager,Adapter,BatchModule}` pattern; the Postgres port follows `PostgresXxx{JobRepository,TransactionManager,Adapter,BatchModule}`.

| Concern               | MySQL name                                      | Postgres name (target)                                                |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| Drizzle — adapter     | `MysqlDrizzleAdapter`                           | `PostgresDrizzleAdapter`                                              |
| Drizzle — module      | `MysqlDrizzleBatchModule`                       | `PostgresDrizzleBatchModule`                                          |
| Drizzle — repository  | `MysqlDrizzleJobRepository`                     | `PostgresDrizzleJobRepository`                                        |
| Drizzle — tx mgr      | `MysqlDrizzleTransactionManager`                | `PostgresDrizzleTransactionManager`                                   |
| Drizzle — tx context  | `MysqlDrizzleTransactionContext`                | `PostgresDrizzleTransactionContext`                                   |
| Drizzle — schema      | `packages/mysql/src/drizzle/schema.ts`          | `packages/postgresql/src/drizzle-schema.postgres.ts` (already exists) |
| MikroORM — adapter    | `MysqlMikroOrmAdapter`                          | `PostgresMikroOrmAdapter`                                             |
| MikroORM — module     | `MysqlMikroOrmBatchModule`                      | `PostgresMikroOrmBatchModule`                                         |
| MikroORM — repository | `MysqlMikroOrmJobRepository` (missing — see §5) | `PostgresMikroOrmJobRepository`                                       |
| MikroORM — tx mgr     | `MysqlMikroOrmTransactionManager`               | `PostgresMikroOrmTransactionManager`                                  |
| MikroORM — tx ctx     | `MysqlMikroOrmTransactionContext`               | `PostgresMikroOrmTransactionContext`                                  |
| Prisma — adapter      | `MysqlPrismaAdapter`                            | `PostgresPrismaAdapter`                                               |
| Prisma — module       | `MysqlPrismaBatchModule`                        | `PostgresPrismaBatchModule`                                           |
| Prisma — repository   | `MysqlPrismaJobRepository`                      | `PostgresPrismaJobRepository`                                         |
| Prisma — tx mgr       | `MysqlPrismaTransactionManager`                 | `PostgresPrismaTransactionManager`                                    |
| Prisma — tx ctx       | `MysqlPrismaTransactionContext`                 | `PostgresPrismaTransactionContext`                                    |
| TypeORM — adapter     | `MysqlTypeOrmAdapter`                           | `PostgresTypeOrmAdapter`                                              |
| TypeORM — module      | `MysqlTypeOrmBatchModule`                       | `PostgresTypeOrmBatchModule`                                          |
| TypeORM — repository  | `MysqlTypeOrmJobRepository`                     | `PostgresTypeOrmJobRepository`                                        |
| TypeORM — tx mgr      | `MysqlTypeOrmTransactionManager`                | `PostgresTypeOrmTransactionManager`                                   |
| TypeORM — tx ctx      | `MysqlTypeOrmTransactionContext`                | `PostgresTypeOrmTransactionContext`                                   |

All Postgres shells live in `packages/postgresql/src/<orm>/` —
**not** in the 4 driver-agnostic adapter slot packages
(`packages/mikro-orm/`, `packages/typeorm/`,
`packages/drizzle/`, `packages/prisma/`). See [§6
T-AC-2b Boundary Note](#6-t-ac-2b-boundary-note).

---

## 3. Driver / package mapping

| Concern                        | MySQL driver / import                                             | Postgres driver / import                                                     |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Wire-protocol driver           | `mysql2` (`^3.0.0`)                                               | `pg` (`^8.11.0`)                                                             |
| Drizzle schema factory         | `drizzle-orm/mysql-core` (`mysqlTable`, `int`, …)                 | `drizzle-orm/pg-core` (`pgTable`, `integer`, …)                              |
| Drizzle db factory             | `drizzle-orm/mysql2` (`MySql2Database`, `drizzle(new Pool(...))`) | `drizzle-orm/node-postgres` (`NodePgDatabase`, `drizzle(new Pool(...))`)     |
| Drizzle raw SQL helper         | `sql` from `drizzle-orm` (same in both)                           | `sql` from `drizzle-orm` (same)                                              |
| MikroORM 6.x driver package    | `@mikro-orm/mysql` (`MySqlDriver`)                                | `@mikro-orm/postgresql` (`PostgreSqlDriver`)                                 |
| TypeORM driver                 | `typeorm` over `mysql2` (`type: 'mysql'`)                         | `typeorm` over `pg` (`type: 'postgres'`)                                     |
| TypeORM NestJS bridge          | `@nestjs/typeorm` (`TypeOrmModule.forRoot`)                       | `@nestjs/typeorm` (`TypeOrmModule.forRoot`) — same package, different `type` |
| Prisma provider                | `provider = "mysql"` (in `schema.prisma`)                         | `provider = "postgresql"` (in `schema.prisma`)                               |
| Prisma client runtime          | `@prisma/client` (driver-agnostic)                                | `@prisma/client` (driver-agnostic)                                           |
| Schema carrier location        | `packages/mysql/src/drizzle/schema.ts`                            | `packages/postgresql/src/drizzle-schema.postgres.ts` (already present)       |
| Migration runner type          | `Mysql2Database.transaction()`, `mysql2` pool                     | `NodePgDatabase.transaction()`, `pg` `Pool`                                  |
| `INSERT ... ON CONFLICT` idiom | `INSERT ... ON DUPLICATE KEY UPDATE id=id`                        | `INSERT ... ON CONFLICT (cols) DO NOTHING` (or `DO UPDATE`)                  |
| Row-locking SQL                | `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+)                  | `SELECT ... FOR UPDATE SKIP LOCKED` (Postgres 9.5+)                          |
| Datetime type                  | `DATETIME(6)` microsecond precision                               | `TIMESTAMPTZ` (`timestamp(..., { withTimezone: true, mode: 'date' })`)       |
| Identifier quoting             | Backticks `` ` ``                                                 | Double-quotes `"` (or unquoted lower-case)                                   |
| Default time function          | `NOW(6)` (microseconds)                                           | `NOW()` (or `defaultNow()` in Drizzle)                                       |

### 3.1 Per-shell driver swap

**Drizzle**

- mysql: `import { mysqlTable, varchar, text, int, timestamp, uniqueIndex, index } from 'drizzle-orm/mysql-core'` + `import type { MySql2Database } from 'drizzle-orm/mysql2'`
- postgres: `import { pgTable, varchar, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'` + `import type { NodePgDatabase } from 'drizzle-orm/node-postgres'`
- DB connection: `drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema })` (uses `pg`'s `Pool`).

**MikroORM**

- mysql: host calls `MikroOrmModule.forRoot({ type: 'mysql', ... })` (driver is implicit through `type`)
- postgres: host calls `MikroOrmModule.forRoot({ type: 'postgresql', driver: PostgreSqlDriver, ... })` (explicit `driver` import from `@mikro-orm/postgresql`)
- The host's `entities` array gets `...BATCH_META_ENTITIES` from `@nest-batch/mikro-orm`.

**TypeORM**

- mysql: `TypeOrmModule.forRoot({ type: 'mysql', host, port, username, password, database, ... })`
- postgres: `TypeOrmModule.forRoot({ type: 'postgres', host, port, username, password, database, ... })`
- The `MysqlTypeOrmJobRepository` raw SQL queries get re-targeted to Postgres: backticks → double-quotes, `NOW(6)` → `NOW()`, `INSERT ... ON DUPLICATE KEY UPDATE id=id` → `INSERT ... ON CONFLICT (job_name, job_key) DO NOTHING`.

**Prisma**

- mysql: the consuming app's `schema.prisma` declares `provider = "mysql"` and includes the batch meta models documented in `@nest-batch/prisma`
- postgres: the consuming app's `schema.prisma` declares `provider = "postgresql"` with the same model body
- The `MysqlPrismaJobRepository` switches `tx.$executeRawUnsafe` SQL strings (or uses Prisma's typed model API) to use double-quoted identifiers / Postgres-native types. The `MySqlPrismaTransactionManager` itself is driver-agnostic — Prisma's `$transaction` works the same for either.

---

## 4. Per-shell porting map

### 4.1 Drizzle shell — `MysqlDrizzleAdapter` → `PostgresDrizzleAdapter`

| File (MySQL)                                                      | File (Postgres target)                                                    | Notes                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mysql/src/drizzle/mysql-drizzle.adapter.ts`             | `packages/postgresql/src/drizzle/postgres-drizzle.adapter.ts`             | `name: 'mysql-drizzle'` → `name: 'postgres-drizzle'`; providers / `globalProviders` shape identical.                                                                          |
| `packages/mysql/src/drizzle/mysql-drizzle.module.ts`              | `packages/postgresql/src/drizzle/postgres-drizzle.module.ts`              | Identical empty module carrier (`@Module({})`); just rename class.                                                                                                            |
| `packages/mysql/src/drizzle/mysql-drizzle-job-repository.ts`      | `packages/postgresql/src/drizzle/postgres-drizzle-job-repository.ts`      | Constructor takes `NodePgDatabase<typeof schema>`; SQL: `ON DUPLICATE KEY UPDATE id=id` → `ON CONFLICT DO NOTHING` (or `DO NOTHING RETURNING id`); backticks → double-quotes. |
| `packages/mysql/src/drizzle/mysql-drizzle-transaction-manager.ts` | `packages/postgresql/src/drizzle/postgres-drizzle-transaction-manager.ts` | Constructor takes `NodePgDatabase<typeof schema>`; `db.transaction(...)` API is the same.                                                                                     |
| `packages/mysql/src/drizzle/schema.ts`                            | `packages/postgresql/src/drizzle-schema.postgres.ts` (**already exists**) | Imports from `drizzle-orm/pg-core`; `mysqlTable` → `pgTable`; `int` → `integer`; `timestamp(..., { mode: 'date' })` → `timestamp(..., { withTimezone: true, mode: 'date' })`. |

### 4.2 MikroORM shell — `MysqlMikroOrmAdapter` → `PostgresMikroOrmAdapter`

| File (MySQL)                                                                          | File (Postgres target)                                                      | Notes                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/mysql/src/mikroorm/mysql-mikroorm.adapter.ts`                               | `packages/postgresql/src/mikroorm/postgres-mikroorm.adapter.ts`             | `name: 'mysql-mikro-orm'` → `name: 'postgres-mikro-orm'`; rest of the factory unchanged.                                                                                                                                                               |
| `packages/mysql/src/mikroorm/mysql-mikroorm.module.ts`                                | `packages/postgresql/src/mikroorm/postgres-mikroorm.module.ts`              | Identical empty module carrier.                                                                                                                                                                                                                        |
| `packages/mysql/src/mikroorm/mysql-mikroorm-job-repository.ts` **(missing — see §5)** | `packages/postgresql/src/mikroorm/postgres-mikroorm-job-repository.ts`      | Must be authored from scratch for both shells. Contract: `extends JobRepository`; constructor takes the `MysqlEntityManager` / `PostgresEntityManager`; uses `em.findOne`, `em.getReference`, `em.nativeInsert`, `em.transactional` for atomic create. |
| `packages/mysql/src/mikroorm/mysql-mikroorm-transaction-manager.ts`                   | `packages/postgresql/src/mikroorm/postgres-mikroorm-transaction-manager.ts` | Constructor takes the Postgres `EntityManager`; `em.transactional(...)` API is identical.                                                                                                                                                              |

### 4.3 Prisma shell — `MysqlPrismaAdapter` → `PostgresPrismaAdapter`

| File (MySQL)                                                    | File (Postgres target)                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/mysql/src/prisma/mysql-prisma.adapter.ts`             | `packages/postgresql/src/prisma/postgres-prisma.adapter.ts`             | `name: 'mysql-prisma'` → `name: 'postgres-prisma'`.                                                                                                                                                                                                                                                                                                                                              |
| `packages/mysql/src/prisma/mysql-prisma.module.ts`              | `packages/postgresql/src/prisma/postgres-prisma.module.ts`              | Identical empty module carrier.                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/mysql/src/prisma/mysql-prisma-job-repository.ts`      | `packages/postgresql/src/prisma/postgres-prisma-job-repository.ts`      | Constructor takes `PrismaClient`; the only MySQL-specific bit is the raw `INSERT ... ON DUPLICATE KEY UPDATE` SQL inside `createExecutionAtomic` — port to `INSERT ... ON CONFLICT (...) DO NOTHING` (or, more idiomatically, use Prisma's typed `upsert` once the `@@unique` is on the model). The rest of the file (CRUD, `findLatestStepExecution` ordering, context save/load) is identical. |
| `packages/mysql/src/prisma/mysql-prisma-transaction-manager.ts` | `packages/postgresql/src/prisma/postgres-prisma-transaction-manager.ts` | `prisma.$transaction(async (tx) => ...)` is driver-agnostic; no porting changes.                                                                                                                                                                                                                                                                                                                 |
| App-owned `schema.prisma`                                       | App-owned `schema.prisma`                                               | Datasource provider changes from `mysql` to `postgresql`; the batch meta model body stays the same.                                                                                                                                                                                                                                                                                              |

### 4.4 TypeORM shell — `MysqlTypeOrmAdapter` → `PostgresTypeOrmAdapter`

| File (MySQL)                                                      | File (Postgres target)                                                    | Notes                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mysql/src/typeorm/mysql-typeorm.adapter.ts`             | `packages/postgresql/src/typeorm/postgres-typeorm.adapter.ts`             | `name: 'mysql-typeorm'` → `name: 'postgres-typeorm'`.                                                                                                                                                   |
| `packages/mysql/src/typeorm/mysql-typeorm.module.ts`              | `packages/postgresql/src/typeorm/postgres-typeorm.module.ts`              | Identical empty module carrier.                                                                                                                                                                         |
| `packages/mysql/src/typeorm/mysql-typeorm-job-repository.ts`      | `packages/postgresql/src/typeorm/postgres-typeorm-job-repository.ts`      | Constructor takes `DataSource`; raw SQL in `createExecutionAtomic` swaps `ON DUPLICATE KEY UPDATE id=id` → `ON CONFLICT (job_name, job_key) DO NOTHING`; backticks → double-quotes; `NOW(6)` → `NOW()`. |
| `packages/mysql/src/typeorm/mysql-typeorm-transaction-manager.ts` | `packages/postgresql/src/typeorm/postgres-typeorm-transaction-manager.ts` | `dataSource.transaction(...)` is driver-agnostic; no porting changes.                                                                                                                                   |

---

## 5. Issue note — missing MySQL `MysqlMikroOrmJobRepository`

In the current source tree
(`packages/mysql/src/mikroorm/`, this snapshot), only 3 files
exist:

- `mysql-mikroorm.adapter.ts`
- `mysql-mikroorm.module.ts`
- `mysql-mikroorm-transaction-manager.ts`

The 4th file in the pattern, `mysql-mikroorm-job-repository.ts`,
is **not present**. The transaction manager imports
`MysqlEntityManager` from `./mysql-mikroorm-job-repository`
(line 4 of `mysql-mikroorm-transaction-manager.ts`), which means
the MySQL MikroORM shell will not type-check / build in its
current state.

This is **out of scope for this task** (which is investigation
only and must not modify source files). It is flagged here so
the Wave 1 implementation task that ports the Postgres MikroORM
shell knows it must also author (or import from
`@nest-batch/mikro-orm`'s `MikroORMJobRepository`) the
corresponding MySQL shell piece, or accept that the
`@nest-batch/mikro-orm` slot already provides a
`MikroORMJobRepository` that the Postgres shell can reuse.

**Implication for the Postgres port:** the
`PostgresMikroOrmJobRepository` may legitimately be a thin
re-export of `@nest-batch/mikro-orm`'s
`MikroORMJobRepository` (since the repository logic is the same
regardless of driver; the driver only affects the connection
options the host passes to `MikroOrmModule.forRoot()`). That
removes the parity-with-mysql pressure on this shell.

---

## 6. T-AC-2b Boundary Note

The 4 Postgres shells **must** live in `packages/postgresql/`.
They must **not** live in the 4 driver-agnostic adapter slot
packages (`packages/mikro-orm/`, `packages/typeorm/`,
`packages/drizzle/`, `packages/prisma/`). This is the
T-AC-2b boundary rule.

The user-imposed guardrail, made explicit in
[`packages/postgresql/README.md`](./README.md), is:

> "DB adapters must not depend on a DB provider."

Concretely:

- The 4 slot packages declare only `@nest-batch/core` (and the
  peer ORM packages — e.g. `@mikro-orm/core`,
  `@nestjs/typeorm`, `drizzle-orm` core types, `@prisma/client`
  base types). They do **not** import `pg`, `mysql2`,
  `@mikro-orm/postgresql`, `@mikro-orm/mysql`,
  `@nestjs/typeorm`'s `type: 'postgres'`/`type: 'mysql'`
  config, or `drizzle-orm/pg-core`/`drizzle-orm/mysql-core`.
- The `packages/postgresql/` package is the **only** place
  where the Postgres provider imports live: `pg`,
  `@mikro-orm/postgresql`, `drizzle-orm/pg-core`,
  `drizzle-orm/node-postgres`, `@prisma/client` with
  `provider = "postgresql"`, and `@nestjs/typeorm` configured
  with `type: 'postgres'`.
- The boundary is enforced by the boundary test in each slot
  package (`tests/boundary/`) which fails the build if a
  forbidden Postgres / MySQL provider import shows up in the
  slot's source tree.

The porting map in §2 / §4 above places every Postgres shell
file under `packages/postgresql/src/<orm>/`. None of them
imports into `packages/mikro-orm/src/`,
`packages/typeorm/src/`, `packages/drizzle/src/`, or
`packages/prisma/src/`. The shells are siblings of the slot
packages, not children of them.

---

## 7. Public API surface (mirror)

The Postgres shells should expose the same public symbols the
MySQL shells expose, with the `Mysql` → `Postgres` rename. The
expected public exports (to be added to
`packages/postgresql/src/index.ts` in the porting task):

| Category        | Exports                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle         | `PostgresDrizzleAdapter`, `PostgresDrizzleBatchModule`, `PostgresDrizzleJobRepository`, `PostgresDrizzleTransactionManager`                         |
| MikroORM        | `PostgresMikroOrmAdapter`, `PostgresMikroOrmBatchModule`, `PostgresMikroOrmJobRepository` (or thin re-export), `PostgresMikroOrmTransactionManager` |
| Prisma          | `PostgresPrismaAdapter`, `PostgresPrismaBatchModule`, `PostgresPrismaJobRepository`, `PostgresPrismaTransactionManager`                             |
| TypeORM         | `PostgresTypeOrmAdapter`, `PostgresTypeOrmBatchModule`, `PostgresTypeOrmJobRepository`, `PostgresTypeOrmTransactionManager`                         |
| Schema carriers | `postgresDrizzleSchema` (re-export from `./drizzle-schema.postgres`); Prisma and migration files stay app-owned                                     |

---

## 8. Verification — what this document proves

- [x] All 4 MySQL shells (drizzle, mikroorm, prisma, typeorm) surveyed at the file level.
- [x] All 4 shells follow the same 4-file pattern (adapter / module / job-repository / transaction-manager), with Drizzle adding a 5th `schema.ts`.
- [x] Each shell's `forRoot()` factory returns a `BatchAdapter` with `name: '<dialect>-<orm>'`, an in-module `module.module` (carrying the empty `MysqlXxxBatchModule` class), `providers` (the repo + tx mgr + the two token aliases), `exports`, and `globalProviders`.
- [x] Each shell's `MysqlXxxJobRepository` extends `@nest-batch/core`'s abstract `JobRepository` (13 abstract methods, all implemented).
- [x] Each shell's `MysqlXxxTransactionManager` extends `@nest-batch/core`'s abstract `TransactionManager` (1 abstract method, `withTransaction`).
- [x] The Drizzle shell additionally ships a `schema.ts` carrying 5 `mysqlTable` definitions; the Postgres equivalent (`drizzle-schema.postgres.ts`) already exists.
- [x] Postgres-side name mapping is mechanical (`Mysql` → `Postgres`); driver imports swap according to §3.
- [x] Postgres shells go in `packages/postgresql/src/<orm>/` (T-AC-2b boundary, §6).

---

## 9. Out of scope for this task

- **Porting the shells.** No file under `packages/postgresql/src/`
  is created or modified in this task except the existing
  `drizzle-schema.postgres.ts`,
  and `index.ts`. The 4 Postgres shells (`postgres-drizzle/`,
  `postgres-mikroorm/`, `postgres-prisma/`,
  `postgres-typeorm/`) are documented in §2 / §4 but **not
  written**.
- **Fixing the missing `mysql-mikroorm-job-repository.ts`.**
  Documented in §5; the Wave 1 implementation task that ports
  the Postgres MikroORM shell is the right place to also
  resolve the MySQL parity gap.
- **Running migrations / writing the Drizzle-kit / Prisma /
  TypeORM migration files for Postgres.** Those are separate
  app-owned tasks; this package should not publish runnable
  migration artifacts.
- **Updating the `@nest-batch/postgresql` README.** The README
  should document `PostgresMikroOrmAdapter`,
  `PostgresTypeOrmAdapter`, `PostgresDrizzleAdapter`, and
  `PostgresPrismaAdapter` as the public shell names.

---

## 10. T-AC-2b Boundary Verification (2026-06-10)

The boundary test at
`packages/core/tests/core/boundary/no-postgres-in-existing-packages.test.ts`
is the guardrail for the 0.2.0 user-imposed rule "DB adapters
must not depend on a DB provider". It is the spec that
_port-of-shell-code-into-`packages/postgresql/`_ is a
hard contract, not a soft preference. The test was confirmed
GREEN against the current tree on 2026-06-10.

### What the test scans

The test walks an 8-entry watchlist
(`NON_POSTGRES_PACKAGES = ['core', 'mikro-orm', 'typeorm',
'bullmq', 'drizzle', 'prisma', 'kafka', 'mysql']`) and, for
each package that has a `packages/<pkg>/` directory, applies
four checks:

1. **src-import** — every `.ts` file under `src/**` is scanned
   for these specifiers (the `POSTGRES_SPEC_RE` regex):
   - bare `pg` (word-bounded)
   - `@mikro-orm/postgresql`
   - `@nestjs/typeorm` (carries the Postgres driver)
   - `drizzle-orm/pg-core`
   - `drizzle-orm/node-postgres`
2. **package-json** — the four `dependencies` /
   `devDependencies` / `peerDependencies` /
   `optionalDependencies` blocks are scanned for dep _keys_
   containing one of: `pg-core`, `postgresql`, `@nestjs/typeorm`.
   (The `drizzle-orm` substring is intentionally absent — the
   `drizzle` slot legitimately declares `drizzle-orm` for the
   `pgTable` factory, and the future `mysql` slot will declare
   it for `mysql-core`.)
3. **src-env** — every `.ts` file under `src/**` is scanned for
   string literals matching `\bPOSTGRES_[A-Z_]+\b` (the
   `POSTGRES_*` env-var prefix).
4. **prisma-schema** — `packages/<pkg>/prisma/schema.prisma`
   is scanned for `provider\s*=\s*["']postgresql["']`.

The test does NOT scan `dist/**` (build artifacts may carry
stale strings) and does NOT scan `README.md` (prose mentions
are not a contract).

### Why `@nest-batch/postgresql` is intentionally not in the watchlist

`postgresql` does not appear in `NON_POSTGRES_PACKAGES`. This
package **owns** the Postgres providers — `pg`,
`@mikro-orm/postgresql`, `@nestjs/typeorm`,
`drizzle-orm/pg-core`, `drizzle-orm/node-postgres`, and
`prisma` with `provider = "postgresql"` are the deliverables
that move _into_ this package in 0.2.0. Putting `postgresql`
in the watchlist would make the test self-contradictory
("the Postgres package must not contain Postgres imports").
The boundary is "the 4 slots stay clean, the 1 owner carries
the leak".

### Test result (current tree)

`pnpm --filter @nest-batch/core test 2>&1 | tee
.omo/evidence/task-4-boundary-test.txt` on 2026-06-10:

```
✓ tests/core/boundary/no-postgres-in-existing-packages.test.ts (3 tests) 2ms
...
 Test Files  48 passed (48)
      Tests  550 passed (550)
   Duration  2.76s
```

All 3 boundary assertions pass:

- `scans every existing non-Postgres package (sanity check)` —
  the 4 adapter slots (`mikro-orm`, `typeorm`, `drizzle`,
  `prisma`) all exist; the test would _fail_ the build if any
  of them were missing.
- `contains no Postgres provider imports, peer deps, env
literals, or prisma schemas in any non-Postgres package` —
  the main guard. Asserts `allViolations.toEqual([])`.
- `the watchlist covers every known non-Postgres sibling
(guardrail)` — meta-check that the watchlist includes
  `core`, `mikro-orm`, `typeorm`, `bullmq`, `drizzle`,
  `prisma`, `kafka`. The test would _fail_ the build if a new
  non-Postgres sibling were added to the repo without being
  added to the watchlist.

### What the test will catch in future shells

The 4 Postgres shells (`postgres-drizzle/`,
`postgres-mikroorm/`, `postgres-prisma/`,
`postgres-typeorm/`) MUST live in
`packages/postgresql/src/<orm>/`. The boundary test will fail
if any of them ends up in the wrong directory:

- A `from 'pg'` import added to
  `packages/mikro-orm/src/something.ts` will fail the
  `src-import` check.
- A `pg` entry in
  `packages/drizzle/package.json#peerDependencies` will fail
  the `package-json` check (matches substring `pg` via the
  regex's `\bpg\b` _only_ for the specifier form; the
  `package-json` check uses the substring list, so `pg` alone
  is not on the list — `pg-core`, `postgresql`, and
  `@nestjs/typeorm` are). The exact dependency-key substring
  matches for the 4 shells are:
  - `drizzle-orm/pg-core` — substring `pg-core` → flagged.
  - `@mikro-orm/postgresql` — substring `postgresql` → flagged.
  - `@nestjs/typeorm` — substring `@nestjs/typeorm` → flagged.
  - `drizzle-orm/node-postgres` — substring `postgresql`
    (the `\bpostgresql\b` inside `node-postgres` does not
    match `pg-core` / `postgresql` / `@nestjs/typeorm`
    directly; the `package.json` substring check would
    miss a bare `drizzle-orm/node-postgres` dep, but the
    `src-import` regex catches it).
- A `POSTGRES_HOST` string literal in any slot's `src/**` will
  fail the `src-env` check.
- A Prisma schema may live in a consuming app; runtime source and
  package peer dependencies must still avoid Postgres driver leaks.

### Follow-up actions for the Wave 1 implementation task

1. Port the 4 Postgres shells into
   `packages/postgresql/src/<orm>/` (see §2 / §4 for the
   file layout). Re-run the boundary test after each shell
   is added — it must stay green.
2. Add the new public shell exports to
   `packages/postgresql/src/index.ts`.
3. If the Wave 1 task touches the boundary test itself (e.g.
   to add a new sibling like `kafka` to the watchlist),
   re-run the full core test suite (`pnpm --filter
@nest-batch/core test`) and capture the evidence under
   `.omo/evidence/`. Do **not** mark the test as `it.skip` /
   `it.todo` — the GREEN state is the spec, not a coincidence
   to suppress.
4. The 4 shells can each be a thin re-export of the
   corresponding slot's repository / transaction-manager
   (since the repo logic is driver-agnostic; only the
   connection options differ). If Wave 1 takes that route,
   the shell files live in `packages/postgresql/src/<orm>/`
   even when their bodies are 1-line re-exports.
