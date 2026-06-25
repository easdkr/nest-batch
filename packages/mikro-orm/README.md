# `@nest-batch/mikro-orm`

The MikroORM 6.x adapter slot for [`@nest-batch/core`](../core). It
owns the MikroORM meta-entity classes, the
`MikroORMJobRepository`, and the `MikroORMTransactionManager`
implementation that satisfy the core contract suite. Driver sibling
packages such as [`@nest-batch/postgresql`](../postgresql) own the
dialect-specific shells and driver peer dependencies; consuming apps
generate and own their runnable migrations.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/mikro-orm  ──▶  @nest-batch/core
        │
        └──────▶  @mikro-orm/core, @mikro-orm/nestjs (peer)
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

| Package             | Range         |
| ------------------- | ------------- |
| `@nest-batch/core`  | `workspace:*` |
| `@nestjs/common`    | `^11.0.0`     |
| `@mikro-orm/core`   | `^6.0.0`      |
| `@mikro-orm/nestjs` | `^6.0.0`      |

The adapter targets **MikroORM 6.x only**. Versions outside that
range (notably 5.x) are not supported. The peer range is hard-pinned
to `^6.0.0` and the boundary test in core ensures the version stays
current.

---

## Entity Ownership

This package owns the 5 active MikroORM meta-entity classes because
`MikroORMJobRepository` instantiates those class identities directly.
The consuming app includes these entities in its MikroORM config and
generates migrations through its own MikroORM migration workflow.

| Table                          | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `batch_job_instance`           | One row per logical job (unique on `job_name`+`job_key`).                          |
| `batch_job_execution`          | One row per job run. Holds status, start/end, exit code/message.                   |
| `batch_step_execution`         | One row per step run. Holds step status, exit code/message, last-chunk checkpoint. |
| `batch_job_execution_context`  | JSON checkpoint + execution context (job-scoped).                                  |
| `batch_step_execution_context` | JSON checkpoint + execution context (step-scoped).                                 |

The shape intentionally omits `batch_job_execution_params`; job
parameters are stored as a serialized snapshot on
`batch_job_execution.params`. The active-execution unique index is
also intentionally absent: the `SELECT ... FOR UPDATE SKIP LOCKED`
pattern in the `createExecutionAtomic` flow provides the same
guarantee without the constraint's contention profile.

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
registered globally by the adapter, and `MikroOrmDriverProvider` is
aliased to the host `EntityManager`. You do **not** list
`MikroORMJobRepository`, `MikroORMTransactionManager`, or a temporary
`MikroOrmDriverProvider` binding in the `providers` array — they're
already wired.

`BATCH_META_ENTITIES` is the typed tuple of all 5 active batch meta
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
  TypeORM 1.0.0; the two packages expose the same 5-table schema
  contract through ORM-specific entities.
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
