# `@nest-batch/mikro-orm`

The MikroORM 6.x adapter for [`@nest-batch/core`](../core). It owns
the Spring Batch-compatible batch meta-schema (entities + migrations)
and ships the `JobRepository` and `TransactionManager` implementations
that satisfy the core contract suite.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/mikro-orm  ──▶  @nest-batch/core
        │
        └──────▶  @mikro-orm/core, @mikro-orm/postgresql, @mikro-orm/nestjs (peer)
```

`@nest-batch/core` does not know this package exists. It cannot. The
boundary is enforced by a core test that fails the build if any
`mikro-orm` import shows up in core.

---

## Install

```bash
pnpm add @nest-batch/mikro-orm
```

Peer dependencies the host must already provide:

| Package                 | Range         |
| ----------------------- | ------------- |
| `@nest-batch/core`      | `workspace:*` |
| `@nestjs/common`        | `^11.0.0`     |
| `@mikro-orm/core`       | `^6.0.0`      |
| `@mikro-orm/nestjs`     | `^6.0.0`      |
| `@mikro-orm/postgresql` | `^6.0.0`      |

The adapter targets **MikroORM 6.x only**. Versions outside that
range (notably 5.x) are not supported. The peer range is hard-pinned
to `^6.0.0` and the boundary test in core ensures the version stays
current.

---

## Schema ownership

This package owns the six batch meta tables. Apps that depend on
`@nest-batch/mikro-orm` get them as part of the install, and the
migrations are versioned alongside the package.

| Table                          | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `batch_job_instance`           | One row per logical job (unique on `job_name`+`job_key`).                          |
| `batch_job_execution`          | One row per job run. Holds status, start/end, exit code/message.                   |
| `batch_job_execution_params`   | Composite-keyed params (one row per param name).                                   |
| `batch_step_execution`         | One row per step run. Holds step status, exit code/message, last-chunk checkpoint. |
| `batch_job_execution_context`  | JSON checkpoint + execution context (job-scoped).                                  |
| `batch_step_execution_context` | JSON checkpoint + execution context (step-scoped).                                 |

The shape is the Spring Batch meta-schema with two omissions: the
classic `BATCH_STEP_EXECUTION_PARAMS` table is intentionally not
shipped (step params are derivable from the parent job execution
params plus the step execution context), and the active-execution
unique index is intentionally absent (the
`SELECT ... FOR UPDATE SKIP LOCKED` pattern in the
`createExecutionAtomic` flow provides the same guarantee without
the constraint's contention profile).

### Migrations

Migrations live in `src/migrations/` and are exported as
`CreateBatchMeta001`, `AddStepExecutionExitFields003`, etc. The full
list:

- `001-create-batch-meta.ts` — the six base tables.
- `003-add-step-execution-exit-fields.ts` — adds `exit_code` /
  `exit_message` to `batch_step_execution`.
- `004-add-active-execution-unique-index.ts` — adds the active-
  execution unique index. (See history below.)
- `005-drop-active-execution-unique-index.ts` — drops the index added
  by 004. The unique index was retired in favor of
  `SELECT ... FOR UPDATE SKIP LOCKED`, which serializes concurrent
  launches without the constraint's write-contention cost.

Apps that already have a MikroORM migration directory should copy
these files in. Apps that don't can point `MikroOrmModule` at this
package's directory.

---

## Wiring

Wire the adapter with two imports in `AppModule.imports`: a host-
owned `MikroOrmModule.forRoot()` call (which builds the connection
and registers the meta entities) and a `MikroOrmAdapter.forRoot()`
carrier passed to
`NestBatchModule.forRoot({ adapters: { persistence, ... } })`.

### Bring-your-own `MikroOrmModule` (recommended)

If your app already uses `@mikro-orm/nestjs` (the typical case for
a Nest app with user-domain entities), call `MikroOrmModule.forRoot()`
yourself, spread `BATCH_META_ENTITIES` into its `entities` array,
and pass the adapter's no-arg `MikroOrmAdapter.forRoot()` to
`NestBatchModule.forRoot()` under `adapters.persistence`:

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NestBatchModule } from '@nest-batch/core';
import { MikroOrmAdapter, BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import { ProductEntity } from './entities/product.entity';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      dbName: 'nest_batch_demo',
      // ... your existing config
    }),
    NestBatchModule.forRoot({
      adapters: { persistence: MikroOrmAdapter.forRoot() },
    }),
  ],
})
export class AppModule {}
```

`MikroOrmAdapter.forRoot()` takes no arguments on purpose. The host
already owns the `MikroOrmModule.forRoot()` call; the adapter only
declares its own provider and export surface. The
`JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` bindings are
registered globally by the adapter, so you do **not** list
`MikroORMJobRepository` / `MikroORMTransactionManager` in the
`providers` array — they're already wired.

`BATCH_META_ENTITIES` is the typed tuple of all six batch meta
entities. Spread it into your `entities` array once and forget about
it.

> **Warning:** The adapter does **not** call `MikroOrmModule.forRoot()`
> and does **not** create a `MikroORM` connection. If you forget the
> `MikroOrmModule.forRoot()` import, the app boots cleanly and the
> batch module compiles, but the repository throws at first call
> because `EntityManager` injection has nothing to bind to. The two
> pieces are decoupled by design — the adapter is a binding-only
> carrier, and the connection is the host's.

> **Note:** `@mikro-orm/nestjs` defaults to `isGlobal: true`, which
> is what the adapter assumes. Setting `isGlobal: false` breaks
> `EntityManager` injection inside the adapter's own module: the
> `MikroORM` is registered on the host's `MikroOrmModule.forRoot()`
> but the adapter module is `global: true`, so the `EntityManager`
> token it needs is not exported across the boundary. Leave it at
> the default unless you've wired an alternative.

`forRootAsync` is the right call when the connection comes from a
config service or a secret manager. Pass the standard `useFactory`
plus `inject` list to `MikroOrmModule.forRootAsync()` and keep
`MikroOrmAdapter.forRoot()` unchanged — the adapter doesn't care
how the connection is built.

> **Recommended:** If your app runs the MikroORM CLI directly
> (`pnpm mikro-orm migration:create`, `migration:up`, etc.) and
> you don't want to repeat the entity / migrations wiring, reach
> for `createBatchMikroOrmConfig` (exported from
> `@nest-batch/mikro-orm`). It takes the same options you would
> pass to `MikroOrmModule.forRoot()` and auto-merges
> `BATCH_META_ENTITIES` into the `entities` array, plus points
> the migrator at this package's `src/migrations/` directory:
>
> ```ts
> // mikro-orm.config.ts (the file the MikroORM CLI loads)
> import { createBatchMikroOrmConfig } from '@nest-batch/mikro-orm';
> import { ProductEntity } from './entities/product.entity';
>
> export default createBatchMikroOrmConfig({
>   entities: [ProductEntity],
>   dbName: 'nest_batch_demo',
>   // ...other MikroORM options
> });
> ```
>
> The `forRoot()` call on the adapter still takes no args — the
> helper is for CLI / migration use only, not for the Nest module
> wiring above.

---

## DB-first semantics

The repository is the durable source of truth for execution state.
That has two consequences worth calling out:

1. **The DB is canonical.** A BullMQ job is a correlation stamp, not
   a state row. The `JobExecution` row carries the actual
   `status`, `startTime`, `endTime`, `exitCode`, and `exitMessage`.
   If the BullMQ worker crashes mid-run, the DB row stays in
   `STARTED` and the host's recovery path picks it up.

2. **Atomic launches are enforced by the row lock.** The
   `createExecutionAtomic` flow uses
   `INSERT ... ON CONFLICT DO NOTHING` +
   `SELECT ... FOR UPDATE SKIP LOCKED` inside a single transaction
   to serialize concurrent launches. Two callers racing to launch
   the same `jobName + jobKey` get one winner; the loser sees a
   thrown `JobExecutionAlreadyRunningError`.

Restart and checkpoint rely on the DB too. `findLatestStepExecution`
returns the most recent `StepExecution` for `(jobExecutionId, stepName)`
regardless of status, so the executor can load the last-committed
chunk index from the `batch_step_execution_context` row and resume
from there.

---

## What is NOT in this package

- A Drizzle adapter. Drizzle is explicitly excluded from this
  release. See `MIGRATION.md`.
- A TypeORM adapter. Use `@nest-batch/typeorm` if you're on
  TypeORM 1.0.0; the two packages expose the same six-table schema
  with adapter-specific migrations.
- A transport. Use `@nest-batch/bullmq` to wire BullMQ as the
  execution strategy; the transport layer reads the same
  `JobExecution` rows.
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. These are out of scope for the whole `@nest-batch/*`
  family. Hook a `BatchObserver` if you need to ship events
  somewhere.

---

## Scripts

```bash
pnpm --filter @nest-batch/mikro-orm build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/mikro-orm test       # vitest run (uses test Postgres)
pnpm --filter @nest-batch/mikro-orm test:watch # vitest watch
pnpm --filter @nest-batch/mikro-orm test:e2e   # vitest e2e (uses docker compose)
pnpm --filter @nest-batch/mikro-orm typecheck  # tsc --noEmit
```

The contract suite (run via the e2e harness) re-executes the
`@nest-batch/core` shared contract tests against a real
`@nest-batch/mikro-orm` implementation. If you change the
repository or transaction manager, run the e2e suite to confirm
you haven't broken the contract.
