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

> The migration uses `datetime` (not `timestamptz`) on the SQLite
> test driver and `timestamptz` on PostgreSQL production. The
> entities declare `datetime` for portability, and the migration
> handler emits the right per-driver type. This is intentional:
> the test suite runs against `better-sqlite3` for speed, and the
> production driver is PostgreSQL.

---

## Wiring

The package is configured via a `DataSource` and a list of batch
meta entities. There are two common shapes.

### Bring-your-own `DataSource` (recommended)

If your app already builds a TypeORM `DataSource` (the typical case
for a Nest app that uses `@nestjs/typeorm`), pass it in:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  NestBatchModule,
  JobRepository,
  TransactionManager,
} from '@nest-batch/core';
import {
  NestBatchTypeOrmModule,
  TypeOrmJobRepository,
  TypeOrmTransactionManager,
} from '@nest-batch/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5434,
      username: 'demo',
      password: 'demo',
      database: 'nest_batch_demo',
      entities: [/* your user-domain entities */],
      migrations: [/* your migrations, plus CreateBatchMeta1700000000000 */],
      migrationsRun: true,
    }),
    NestBatchTypeOrmModule.forRoot({
      // The host's DataSource. The module will use it to build
      // a per-request EntityManager and to run the contract suite.
      dataSource: /* your DataSource */,
    }),
    NestBatchModule.forRoot(),
  ],
  providers: [
    { provide: JobRepository, useClass: TypeOrmJobRepository },
    { provide: TransactionManager, useClass: TypeOrmTransactionManager },
  ],
})
export class AppModule {}
```

`forRoot({ dataSource })` is the typical shape. The module reads
the batch meta entities off the registered `DataSource` (you must
register them on the `DataSource` itself, not just the Nest
module). The TypeORM `Repository<Entity>` lookups go through that
same `DataSource`.

### Self-contained module

If you don't have a `DataSource` yet, the package can build one for
you. Pass `entities` and the standard `DataSourceOptions`:

```ts
NestBatchTypeOrmModule.forRoot({
  type: 'better-sqlite3',
  database: ':memory:',
  entities: [...batchMetaEntities /* your entities */],
});
```

`batchMetaEntities` is exported from the package as the tuple of all
six batch meta entities. Spread it into your `entities` array.

`forRootAsync` is also available when the connection comes from a
config service. It mirrors the standard Nest async-module factory
shape and accepts a `useFactory` plus an `inject` list.

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
