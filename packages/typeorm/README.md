# `@nest-batch/typeorm`

The TypeORM 1.0.0 adapter for [`@nest-batch/core`](../core). It owns
the same six Spring Batch-compatible batch meta-tables that
`@nest-batch/mikro-orm` ships, expressed as TypeORM 1.0 entities plus
a bundled migration. It exposes `TypeOrmJobRepository` and
`TypeOrmTransactionManager` and runs the shared core contract suite
against a real TypeORM `DataSource`.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/typeorm  ──▶  @nest-batch/core
        │
        └──────▶  typeorm (peer, ^1.0.0)
```

`@nest-batch/core` does not know this package exists. The boundary is
enforced by a core test that fails the build if any `typeorm` import
shows up in core.

---

## TypeORM 1.0.0-only policy

This adapter targets **TypeORM 1.0.0 only**. The peer range is
`typeorm: ^1.0.0` and intentionally excludes `0.3.x`.

Why 1.0.0 and not 0.3? Two reasons:

1. The `Connection` → `DataSource` rename. TypeORM 1.0.0 finished the
   rename that 0.3 started; the API now exposes `DataSource`,
   `DataSourceOptions`, and `DataSource.transaction()` instead of
   `Connection`, `ConnectionOptions`, and `Connection.transaction()`.
   Maintaining 0.3 support would mean running the full codebase
   through `Connection → DataSource` shims, which is a waste of
   effort when 0.3 is on a separate support track.
2. The entity / migration surface. A few decorators and migration
   helpers moved between 0.3 and 1.0. Supporting both means
   conditional entity definitions, which is a smell.

The peer range is `^1.0.0`, so any 1.x release works. The boundary
test in core and a dedicated peer-range test in this package
together ensure 0.3 does not silently sneak back in.

If you're on TypeORM 0.3, stay on the previous
`@nest-batch/nest-batch` package (pre-rename) or upgrade TypeORM
first. There's no compatibility shim in this release.

---

## Install

```bash
pnpm add @nest-batch/typeorm
```

Peer dependencies the host must already provide:

| Package            | Range         |
| ------------------ | ------------- |
| `@nest-batch/core` | `workspace:*` |
| `typeorm`          | `^1.0.0`      |

`typeorm` is a hard peer (declared in `peerDependencies` with
`optional: false`). The `package.json` also lists it as a
`devDependency` so the package's own test suite can resolve it
without the host.

---

## Schema ownership

This package owns the same six batch meta tables as
`@nest-batch/mikro-orm`:

| Table                          | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `batch_job_instance`           | One row per logical job (unique on `job_name`+`job_key`).                          |
| `batch_job_execution`          | One row per job run. Holds status, start/end, exit code/message.                   |
| `batch_job_execution_params`   | Composite-keyed params (one row per param name).                                   |
| `batch_step_execution`         | One row per step run. Holds step status, exit code/message, last-chunk checkpoint. |
| `batch_job_execution_context`  | JSON checkpoint + execution context (job-scoped).                                  |
| `batch_step_execution_context` | JSON checkpoint + execution context (step-scoped).                                 |

The bundled migration lives at
`src/migrations/1700000000000-CreateBatchMeta.ts` and is exported
as `CreateBatchMeta1700000000000` from the package root. Apps that
already have a TypeORM migration directory should copy the file in
and renumber it to fit their own migration sequence.

> **Note:** The six batch meta entities are also exported as a
> single tuple under `batchMetaEntities` from the package root.
> Because the adapter no longer bootstraps the `DataSource` (the
> host owns the `TypeOrmModule.forRoot()` call), spreading
> `batchMetaEntities` into your own `entities` array is the only
> way the meta tables are registered with TypeORM's metadata
> system. Forgetting the spread means `Repository<Entity>` lookups
> for the meta tables fail silently and the repository throws at
> first call.

> The migration uses `datetime` (not `timestamptz`) on the SQLite
> test driver and `timestamptz` on PostgreSQL production. The
> entities declare `datetime` for portability, and the migration
> handler emits the right per-driver type. This is intentional:
> the test suite runs against `better-sqlite3` for speed, and the
> production driver is PostgreSQL.

---

## Wiring

Wire the adapter with two imports in `AppModule.imports`: a host-
owned `TypeOrmModule.forRoot()` call (which builds the
`DataSource` and registers the meta entities) and a
`TypeOrmAdapter.forRoot()` carrier passed to
`NestBatchModule.forRoot({ adapters: { persistence, ... } })`.

### Bring-your-own `DataSource` (recommended)

If your app already uses `@nestjs/typeorm` (the typical case for a
Nest app with user-domain entities), call
`TypeOrmModule.forRoot()` yourself, spread `batchMetaEntities()`
into its `entities` array, and pass the adapter's no-arg
`TypeOrmAdapter.forRoot()` to `NestBatchModule.forRoot()` under
`adapters.persistence`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NestBatchModule } from '@nest-batch/core';
import {
  batchMetaEntities,
  CreateBatchMeta1700000000000,
  TypeOrmAdapter,
} from '@nest-batch/typeorm';
import { ProductEntity } from './entities/product.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5434,
      username: 'demo',
      password: 'demo',
      database: 'nest_batch_demo',
      entities: [ProductEntity, ...batchMetaEntities()],
      migrations: [CreateBatchMeta1700000000000 /* your other migrations */],
      migrationsRun: true,
    }),
    NestBatchModule.forRoot({
      adapters: { persistence: TypeOrmAdapter.forRoot() },
    }),
  ],
})
export class AppModule {}
```

`TypeOrmAdapter.forRoot()` takes no arguments on purpose. The host
already owns the `TypeOrmModule.forRoot()` call; the adapter only
declares its own provider and export surface. The
`JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` bindings are
registered globally by the adapter, so you do **not** list
`TypeOrmJobRepository` / `TypeOrmTransactionManager` in the
`providers` array — they're already wired.

> **Warning:** The adapter does **not** call `TypeOrmModule.forRoot()`
> and does **not** create a `DataSource`. If you forget the
> `TypeOrmModule.forRoot()` import, the app boots cleanly and the
> batch module compiles, but the repository throws at first call
> because `Repository<Entity>` resolution has nothing to bind to.
> The two pieces are decoupled by design — the adapter is a
> binding-only carrier, and the connection is the host's.

> **Note:** `@nestjs/typeorm` defaults to `isGlobal: true`, which
> is what the adapter assumes. Setting `isGlobal: false` breaks
> `EntityManager` injection inside the adapter's own module: the
> `DataSource` is registered on the host's `TypeOrmModule.forRoot()`
> but the adapter module is `global: true`, so the `EntityManager`
> token it needs is not exported across the boundary. Leave it at
> the default unless you've wired an alternative.

`forRootAsync` is the right call when the connection comes from a
config service or a secret manager. Pass the standard `useFactory`
plus `inject` list to `TypeOrmModule.forRootAsync()` and keep
`TypeOrmAdapter.forRoot()` unchanged — the adapter doesn't care
how the `DataSource` is built.

### DataSource, not Connection

TypeORM 1.0.0 calls it `DataSource`. The old `Connection` type is
gone, and so is `getConnection()` / `getRepository()` on the
connection. Every example in this README uses `DataSource`. If
you're migrating from a 0.3 codebase, the rename touches every
test file, every import, and every import path — there is no
`@typeorm/0.3-compat` shim.

The `TypeOrmTransactionManager` accepts a `DataSource` and uses
`dataSource.transaction()` to start a real DB transaction. The
callback receives a transactional `EntityManager`; use that one,
not a globally-injected one, so all reads and writes are part of
the same transaction.

---

## DB-first semantics

The repository is the durable source of truth for execution state.
Same model as the MikroORM adapter, same invariants:

1. **The DB is canonical.** A BullMQ job is a correlation stamp, not
   a state row. The `JobExecution` row carries the actual
   `status`, `startTime`, `endTime`, `exitCode`, and `exitMessage`.
2. **Atomic launches are enforced by the row lock.** The
   `createExecutionAtomic` flow uses a transactional
   `SELECT ... FOR UPDATE SKIP LOCKED` (on PostgreSQL) to serialize
   concurrent launches. Two callers racing to launch the same
   `jobName + jobKey` get one winner; the loser sees a thrown
   `JobExecutionAlreadyRunningError`.
3. **Restart and checkpoint go through the DB.** `findLatestStepExecution`
   returns the most recent `StepExecution` for `(jobExecutionId, stepName)`
   regardless of status, so the executor can load the
   last-committed chunk index from
   `batch_step_execution_context` and resume from there.

The contract suite is the same one `@nest-batch/mikro-orm` runs. If
you change the repository or transaction manager, run the suite to
confirm you haven't broken the contract.

---

## What is NOT in this package

- A TypeORM 0.3 adapter. Use 1.0.0 or stay on the previous package.
- A Drizzle adapter. Drizzle is explicitly excluded from this
  release. See `MIGRATION.md`.
- A MikroORM adapter. Use `@nest-batch/mikro-orm` if you want
  MikroORM 6; the two packages expose the same six-table schema.
- A transport. Use `@nest-batch/bullmq` to wire BullMQ as the
  execution strategy; the transport layer reads the same
  `JobExecution` rows.
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. Out of scope for the whole `@nest-batch/*` family.

---

## Scripts

```bash
pnpm --filter @nest-batch/typeorm build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/typeorm test       # vitest run (uses better-sqlite3 by default)
pnpm --filter @nest-batch/typeorm test:watch # vitest watch
pnpm --filter @nest-batch/typeorm typecheck  # tsc --noEmit
```

The contract suite runs against an in-memory SQLite database by
default. The test driver is `better-sqlite3` because it gives
sub-millisecond setup and teardown, and the contract tests are
database-agnostic enough to not need a full PostgreSQL harness.
For an end-to-end Postgres run, point the suite at your own
`DataSource` via the documented test harness hook.
