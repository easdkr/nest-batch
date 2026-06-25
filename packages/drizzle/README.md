# `@nest-batch/drizzle`

Drizzle ORM adapter SLOT for [`@nest-batch/core`](../core). Owns the
`DrizzleAdapter`, the `DrizzleJobRepository` / `DrizzleTransactionManager`
interface shape, and the driver-agnostic repository contract. Pair with
[`@nest-batch/postgresql`](../postgresql) for the actual Postgres driver
binding, or `@nest-batch/mysql` for the MySQL driver binding.

The package is a **sibling**, not a replacement. The dependency direction
is strict and one-way:

```
@nest-batch/drizzle  ──▶  @nest-batch/core
        │
        └──────▶  drizzle-orm (peer; schema-only), @nestjs/common (peer)
```

`@nest-batch/core` does not know this package exists. It cannot. The
boundary is enforced by a core test that fails the build if any
`drizzle-orm` import shows up in core.

---

## Install

```bash
pnpm add @nest-batch/drizzle
```

Peer dependencies the host must already provide:

| Package            | Range          |
| ------------------ | -------------- |
| `@nest-batch/core` | `workspace:*`  |
| `@nestjs/common`   | `^10 \|\| ^11` |
| `drizzle-orm`      | `^0.40.0`      |

The adapter targets **`drizzle-orm@^0.40.0`**. The peer range is
hard-pinned for 0.2.0; the T10a refactor (Postgres shell extraction)
will widen the range to cover both the Postgres and MySQL driver
imports. See [§6 What is NOT in this package](#6-what-is-not-in-this-package)
and [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.3 for the
shaping context.

---

## Peer dependencies

| Package            | Range          | Notes                                                                                            |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| `@nest-batch/core` | `workspace:*`  | The batch engine; this adapter only extends its DI surface.                                      |
| `@nestjs/common`   | `^10 \|\| ^11` | For `@Module` / `Module` / injection tokens. Nest 10 and 11 are both supported.                  |
| `drizzle-orm`      | `^0.40.0`      | Drizzle core types and SQL helpers. Driver-specific imports live in the driver sibling packages. |

---

## Driver pairing

**This package is driver-agnostic.** It does **not** declare a Postgres
or MySQL driver as a peer dep. Pair with
[`@nest-batch/postgresql`](../postgresql) for Postgres support or
`@nest-batch/mysql` for MySQL support. Those driver sibling packages
own the `pg` / `mysql2` / `drizzle-orm/pg-core` / `drizzle-orm/mysql-core`
imports and dialect-specific table definitions. Importing
`drizzle-orm/node-postgres` or `drizzle-orm/mysql2` directly from this
package is a boundary violation enforced by the T-AC-2b core test.

```bash
# Postgres wiring (the common case)
pnpm add @nest-batch/drizzle @nest-batch/postgresql

# MySQL wiring
pnpm add @nest-batch/drizzle @nest-batch/mysql
```

---

## Wiring

The adapter itself is a no-arg `BatchAdapter` factory. The host owns
the Drizzle ORM connection (typically via
`drizzle-orm/node-postgres` or `drizzle-orm/postgres-js`) and the
app's Drizzle migration pipeline. A typical Postgres wiring looks
like:

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
})
class DbModule {}

@Module({
  imports: [
    DbModule,
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

`PostgresDrizzleAdapter.forRoot()` takes no arguments on purpose. The host
already owns the Drizzle `drizzle()` call; the adapter only declares
its own provider and export surface. The `JOB_REPOSITORY_TOKEN` and
`TRANSACTION_MANAGER_TOKEN` bindings are registered globally by the
adapter, so you do **not** list `DrizzleJobRepository` /
`DrizzleTransactionManager` in the `providers` array — they're
already wired.

The MySQL mirror is the same shape: swap `PostgresDrizzleAdapter` /
`postgresDrizzleSchema` for `MysqlDrizzleAdapter` /
`mysqlDrizzleSchema`, swap `drizzle-orm/node-postgres` for
`drizzle-orm/mysql2`, and use `mysql2`'s `createPool` instead of
`pg`'s `Pool`.

> **Warning:** The adapter does **not** call `drizzle()` and does
> **not** create a `Pool`. If you forget the DB provider binding, the
> app boots cleanly and the batch module compiles, but the repository
> throws at first call because the `NodePgDatabase` injection has
> nothing to bind to. The two pieces are decoupled by design — the
> adapter is a binding-only carrier, and the connection is the host's.

---

## Contract test

The `@nest-batch/core` shared contract suite verifies the
`DrizzleJobRepository` / `DrizzleTransactionManager` implementations
against the public core interfaces. The e2e harness (see
[`tests/e2e-postgres.test.ts`](./tests/e2e-postgres.test.ts)) runs
the contract suite against a real Postgres testcontainer:

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runJobRepositoryContract } from '@nest-batch/core/test-contracts';
import { DrizzleJobRepository, DrizzleTransactionManager } from '@nest-batch/drizzle';
import { postgresDrizzleSchema } from '@nest-batch/postgresql';

const container = await new PostgreSqlContainer('postgres:15-alpine')
  .withDatabase('nest_batch_drizzle')
  .start();
const pool = new Pool({ connectionString: container.getConnectionUri() });
const db = drizzle(pool, { schema: postgresDrizzleSchema });

runJobRepositoryContract(
  {
    create: () => ({
      repo: new DrizzleJobRepository(db),
      tx: new DrizzleTransactionManager(db),
    }),
  },
  'DrizzleJobRepository + DrizzleTransactionManager',
);
```

Run the contract suite locally with a real Postgres (Docker daemon
required):

```bash
RUN_DRIZZLE_E2E=1 pnpm --filter @nest-batch/drizzle test -- tests/e2e-postgres.test.ts
```

The test file is **gated by `RUN_DRIZZLE_E2E=1`**. Without that env
var the test logs a skip notice and exits 0 — the default
`pnpm --filter @nest-batch/drizzle test` run does not start a
container and does not require Docker. CI runs the gated test
against the real Postgres testcontainer as a separate job.

If you change `DrizzleJobRepository` or `DrizzleTransactionManager`,
run the e2e suite to confirm you have not broken the contract.

---

## What is NOT in this package

- A batch engine. The Job / Step / Chunk / Tasklet IR, decorators,
  and runtime live in [`@nest-batch/core`](../core).
- A scheduler / cron firing. The `@BatchScheduled` decorator and the
  BullMQ / Kafka schedule services live in
  [`@nest-batch/core`](../core) and [`@nest-batch/bullmq`](../bullmq).
- A transport. Pair with [`@nest-batch/bullmq`](../bullmq) or
  [`@nest-batch/kafka`](../kafka) to run jobs across processes.
- A Postgres driver. The `pg` / `drizzle-orm/node-postgres` /
  `drizzle-orm/pg-core` / `drizzle-orm/postgres-js` imports live in
  [`@nest-batch/postgresql`](../postgresql). The T-AC-2b core
  boundary test fails the build if any of those land here.
- A MySQL driver. The `mysql2` / `drizzle-orm/mysql2` /
  `drizzle-orm/mysql-core` imports live in
  [`@nest-batch/mysql`](../mysql). The T-AC-2 core boundary test
  fails the build if any of those land here.
- A SQLite driver. SQLite is on the 0.3.0 roadmap
  ([`@nest-batch/sqlite`](../../docs/RELEASE-0.2.0.md#91-sqlite-nest-batchsqlite)).
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. These are out of scope for the whole `@nest-batch/*`
  family. Hook a `BatchObserver` if you need to ship events
  somewhere.
- A migration runner or public SQL migration file. Include the
  dialect-specific Drizzle table definitions in your app's Drizzle
  config and generate/apply migrations in the app repository.

---

## Scripts

```bash
pnpm --filter @nest-batch/drizzle build       # SWC transpile + tsc declarations
pnpm --filter @nest-batch/drizzle test        # vitest run (adapter-shape + contract)
pnpm --filter @nest-batch/drizzle test:watch  # vitest watch
pnpm --filter @nest-batch/drizzle typecheck   # tsc --noEmit
# E2E — gated, requires a running Docker daemon and the env var
RUN_DRIZZLE_E2E=1 pnpm --filter @nest-batch/drizzle test -- tests/e2e-postgres.test.ts
```

The default `pnpm test` run is the adapter-shape test (verifies the
`DrizzleAdapter` structure: `global: true`, 4 providers, 2 exports,
`globalProviders` length 2) and the unit contract test (already runs
the shared `@nest-batch/core` contract suite against a testcontainer
Postgres). The e2e test is a separate, opt-in harness for CI and
release-gate runs.

See [`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.3 and
§3.5 for the stabilization context that ships this README, the
`@nest-batch/postgresql` extraction, and the contract test promotion.
