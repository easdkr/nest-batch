# `@nest-batch/prisma`

Prisma adapter SLOT for [`@nest-batch/core`](../core).

This package owns the Prisma-backed `JobRepository` /
`TransactionManager` implementations and documents the Spring
Batch-compatible batch meta model contract. It does not publish a
runnable `schema.prisma` or Prisma migration directory. It is a
**sibling**, not a replacement. The dependency direction is strict
and one-way:

```
@nest-batch/prisma  ──▶  @nest-batch/core
        │
        └──────▶  @prisma/client, @nestjs/common (peer)
```

`@nest-batch/core` does not know this package exists. It cannot.
The boundary is enforced by a core test that fails the build if
any `prisma` import shows up in core.

This is the **stable** 0.2.0 release shape — Prisma was implicitly
deferred in the 0.1.0 docs even though the package shipped; 0.2.0
promotes it to a stable member of the family. See
[`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.2 and
§3.5 for the release note.

---

## Install

```bash
pnpm add @nest-batch/prisma
```

Peer dependencies the host must already provide:

| Package            | Range          |
| ------------------ | -------------- |
| `@nest-batch/core` | `workspace:*`  |
| `@nestjs/common`   | `^10 \|\| ^11` |
| `@prisma/client`   | `^6.0.0`       |

That is the full peer-dep surface. The adapter does **not** declare
a DB driver as a peer. Runtime driver wiring lives in the database
driver sibling package, and the consuming app owns its generated
client plus Prisma migrations.

---

## Peer dependencies

The `@prisma/client@^6.0.0` peer range is hard-pinned. The adapter
imports `PrismaClient` directly from `@prisma/client`; versions
outside that range (notably 5.x) are not supported.

| Peer               | Range          | Why it ships as a peer                                                                                                                          |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nest-batch/core` | `workspace:*`  | The `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` tokens are exported by core. The adapter only binds them to its own implementations. |
| `@nestjs/common`   | `^10 \|\| ^11` | The adapter registers a Nest `DynamicModule` (`PrismaAdapter.forRoot().module`). The `@Module` decorator comes from `@nestjs/common`.           |
| `@prisma/client`   | `^6.0.0`       | The repository / transaction manager receive a host-owned `PrismaClient` via constructor injection. v6 is the only supported major.             |

The host owns the `PrismaClient` instance and is expected to
generate it once (`prisma generate`) against the project-local
Prisma schema that includes the batch meta models.

---

## Driver pairing

This package owns the Prisma adapter slot. Pair it with
[`@nest-batch/postgresql`](../../packages/postgresql) for Postgres
driver binding or [`@nest-batch/mysql`](../../packages/mysql) for
MySQL driver binding. In both cases, the consuming app's own
`schema.prisma` chooses the datasource provider and includes the
batch meta models below.

The 8-package guardrail (T-AC-2 / T-AC-2b) confirms no Postgres or
MySQL provider leaks into any of the 8 non-target-DB packages.
This package is in the "non-target-DB" runtime set for both — it
ships no DB provider in its `peerDependencies`.

---

## Wiring

Wire the adapter in two pieces in `AppModule.imports`: a host-
owned `PrismaClient` (generated from the app-owned Prisma schema)
and a `PrismaAdapter.forRoot()` carrier passed to
`NestBatchModule.forRoot({ adapters: { persistence, ... } })`.

### 1. Add the batch meta models and generate the client

Add the batch meta models to your app's `schema.prisma`, then run
your normal Prisma generation command:

```bash
pnpm prisma generate --schema=prisma/schema.prisma
```

The model names are part of the adapter contract because the MySQL
Prisma shell uses Prisma's generated model delegates. The Postgres
shell uses raw SQL internally, but keeping the same model names makes
the schema portable across drivers.

```prisma
model BatchJobInstance {
  id        String   @id @db.VarChar(255)
  jobName   String   @map("job_name") @db.VarChar(255)
  jobKey    String   @map("job_key") @db.VarChar(255)
  createdAt DateTime @default(now()) @map("created_at")

  executions BatchJobExecution[]

  @@unique([jobName, jobKey], map: "batch_job_instance_job_name_job_key_unique")
  @@map("batch_job_instance")
}

model BatchJobExecution {
  id            String    @id @db.VarChar(255)
  jobInstanceId String    @map("job_instance_id") @db.VarChar(255)
  status        String    @db.VarChar(20)
  startTime     DateTime? @map("start_time")
  endTime       DateTime? @map("end_time")
  exitCode      String    @default("") @map("exit_code") @db.VarChar(255)
  exitMessage   String    @default("") @map("exit_message") @db.Text
  params        String    @default("{}") @db.Text

  instance BatchJobInstance @relation(fields: [jobInstanceId], references: [id], onDelete: Cascade)
  steps    BatchStepExecution[]

  @@index([jobInstanceId], map: "batch_job_execution_job_instance_id_index")
  @@map("batch_job_execution")
}

model BatchStepExecution {
  id             String   @id @db.VarChar(255)
  jobExecutionId String   @map("job_execution_id") @db.VarChar(255)
  stepName       String   @map("step_name") @db.VarChar(255)
  status         String   @db.VarChar(20)
  readCount      Int      @default(0) @map("read_count")
  writeCount     Int      @default(0) @map("write_count")
  skipCount      Int      @default(0) @map("skip_count")
  rollbackCount  Int      @default(0) @map("rollback_count")
  commitCount    Int      @default(0) @map("commit_count")
  exitCode       String   @default("") @map("exit_code") @db.VarChar(255)
  exitMessage    String   @default("") @map("exit_message") @db.Text
  createdAt      DateTime @default(now()) @map("created_at")

  jobExecution BatchJobExecution @relation(fields: [jobExecutionId], references: [id], onDelete: Cascade)

  @@index([jobExecutionId], map: "batch_step_execution_job_execution_id_index")
  @@map("batch_step_execution")
}

model BatchJobExecutionContext {
  jobExecutionId String @id @map("job_execution_id") @db.VarChar(255)
  data           String @db.Text
  version        Int    @default(0)

  @@map("batch_job_execution_context")
}

model BatchStepExecutionContext {
  stepExecutionId String @id @map("step_execution_id") @db.VarChar(255)
  data            String @db.Text
  version         Int    @default(0)

  @@map("batch_step_execution_context")
}
```

Use provider-specific native types in the app schema when you need
them, for example `@db.Timestamptz(6)` on Postgres or
`@db.DateTime(6)` on MySQL timestamp columns.

### 2. Module wiring

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { PrismaClient } from '@prisma/client';
import { PrismaAdapter, PrismaDriverProvider } from '@nest-batch/prisma';

@Module({
  imports: [
    NestBatchModule.forRoot({
      adapters: { persistence: PrismaAdapter.forRoot() },
    }),
  ],
  providers: [{ provide: PrismaDriverProvider, useValue: new PrismaClient() }],
})
export class AppModule {}
```

`PrismaAdapter.forRoot()` takes no arguments on purpose. The host
already owns the `PrismaClient` lifecycle; the adapter only
declares its own provider and export surface. The
`JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` bindings are
registered globally by the adapter, so you do **not** list
`PrismaJobRepository` / `PrismaTransactionManager` in the
`providers` array — they're already wired.

> **Warning:** The adapter does **not** call `new PrismaClient()`.
> If you forget to provide a `PrismaClient` instance, the app
> boots cleanly and the batch module compiles, but the
> repository throws at first call because `PrismaClient`
> injection has nothing to bind to.

The canonical wiring assumes a Postgres-backed `PrismaClient`
(paired with `@nest-batch/postgresql`). Use a MySQL-backed client
generated from your app-owned MySQL schema when running the MySQL
pairing.

---

## Contract test

The `@nest-batch/core` contract suite covers every behavior every
adapter must satisfy. Run it against the Prisma-backed
`JobRepository` and `TransactionManager`:

```bash
pnpm --filter @nest-batch/prisma test -- tests/contract.test.ts
```

The contract covers `getOrCreateJobInstance`,
`createExecutionAtomic`, `updateJobExecution` / `getJobExecution`,
`createStepExecution` / `updateStepExecution` / `getStepExecution`,
`getExecutionContext` / `saveExecutionContext`,
`findLatestStepExecution`, and the `TransactionManager` contract
(wrap / commit / rollback / nested).

The Prisma implementation is exercised through the shared
`@nest-batch/core/test-contracts` contract. If you change the
repository or transaction manager, run the contract suite to
confirm you haven't broken the contract. The end-to-end
testcontainers variant lives at `tests/e2e-postgres.test.ts` and
is gated by `RUN_PRISMA_E2E=1`:

```bash
RUN_PRISMA_E2E=1 pnpm --filter @nest-batch/prisma test -- tests/e2e-postgres.test.ts
```

The e2e variant runs `prisma db push` against a test-only schema
fixture in a real Postgres container, then re-executes the contract
suite against that database. It exists so Prisma schema regressions
surface in CI without publishing a runnable schema artifact.

---

## Migration

The consuming app owns Prisma migrations. After adding the batch
meta models above to your app schema, use the normal Prisma CLI flow
inside that app:

```bash
export DATABASE_URL=postgres://demo:demo@localhost:5434/nest_batch_demo
pnpm prisma migrate dev --schema=prisma/schema.prisma
pnpm prisma migrate deploy --schema=prisma/schema.prisma
```

`migrate dev` is the development loop; `migrate deploy` is the
production path. The generated migration should create the same
5 active batch meta tables used by the other ORM adapters.

---

## What is NOT in this package

- A DB driver. This package does not declare a Postgres or MySQL
  provider as a peer dep.
- A transport. Use `@nest-batch/bullmq` or `@nest-batch/kafka` to
  wire the execution strategy; the transport layer reads the
  same `JobExecution` rows.
- A MySQL adapter shell. Use `@nest-batch/mysql` for the MySQL
  runtime shell. This package does not ship a `mysql` provider.
- A migration runner or runnable migration artifact. Use the Prisma
  CLI in the consuming app; this package does not re-implement
  migration bookkeeping or publish a schema directory.
- An admin UI, metrics, tracing, webhook, or job visualization
  surface. These are out of scope for the whole `@nest-batch/*`
  family. Hook a `BatchObserver` if you need to ship events
  somewhere.

### Scripts

```bash
pnpm --filter @nest-batch/prisma build                       # SWC transpile + tsc declarations
pnpm --filter @nest-batch/prisma test                        # vitest run (unit + contract)
pnpm --filter @nest-batch/prisma test:watch                  # vitest watch
RUN_PRISMA_E2E=1 \
  pnpm --filter @nest-batch/prisma test -- tests/e2e-postgres.test.ts   # testcontainers Postgres e2e
pnpm --filter @nest-batch/prisma typecheck                   # tsc --noEmit
```

The default `test` script runs the contract suite against a
testcontainers Postgres instance. The e2e suite is opt-in via
`RUN_PRISMA_E2E=1` and runs `prisma db push` against a test-only
schema fixture in a real container before re-executing the
contract. If you change the repository or transaction manager, run
the e2e suite to confirm you haven't broken the contract.
