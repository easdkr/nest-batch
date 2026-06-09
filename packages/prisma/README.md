# `@nest-batch/prisma`

Prisma adapter SLOT for [`@nest-batch/core`](../core).

This package owns the Spring Batch-compatible batch meta-schema
(Prisma schema + migration) and the Prisma-backed `JobRepository` /
`TransactionManager` implementations that satisfy the core contract
suite. It is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

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

| Package            | Range                                                |
| ------------------ | ---------------------------------------------------- |
| `@nest-batch/core` | `workspace:*`                                        |
| `@nestjs/common`   | `^10 \|\| ^11`                                       |
| `@prisma/client`   | `^6.0.0`                                             |

That is the full peer-dep surface. The adapter does **not** declare
a DB driver as a peer — the actual Postgres / MySQL provider
configuration lives in the driver sibling package's bundled
`prisma/schema.prisma`, not here.

---

## Peer dependencies

The `@prisma/client@^6.0.0` peer range is hard-pinned. The adapter
imports `PrismaClient` directly from `@prisma/client`; versions
outside that range (notably 5.x) are not supported.

| Peer                | Range           | Why it ships as a peer                                                                                                                          |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@nest-batch/core`  | `workspace:*`   | The `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` tokens are exported by core. The adapter only binds them to its own implementations. |
| `@nestjs/common`    | `^10 \|\| ^11`  | The adapter registers a Nest `DynamicModule` (`PrismaAdapter.forRoot().module`). The `@Module` decorator comes from `@nestjs/common`.            |
| `@prisma/client`    | `^6.0.0`        | The repository / transaction manager receive a host-owned `PrismaClient` via constructor injection. v6 is the only supported major.              |

The host owns the `PrismaClient` instance and is expected to
generate it once (`prisma generate`) against the project-local
Prisma schema. The 0.2.0 release ships a bundled
`prisma/schema.prisma` (Postgres provider) so a host that wants
Postgres can run the bundled migration without writing their own
schema first.

---

## Driver pairing

This package is **driver-agnostic**. The bundled
`prisma/schema.prisma` ships with a Postgres provider; pair with
[`@nest-batch/postgresql`](../../packages/postgresql) for the
actual Postgres driver binding. The Prisma schema extraction
described in
[`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) §3.3 moves
the bundled `prisma/schema.prisma` into
`@nest-batch/postgresql/prisma/schema.prisma` in a follow-up
release; this README documents the package as driver-agnostic in
advance so the API does not change when that refactor lands.

> **Do not** use this package directly against MySQL today. The
> bundled schema is Postgres-only. The MySQL pairing
> (`@nest-batch/mysql`) ships its own `prisma/schema.prisma`
> with a `mysql` provider.

The 8-package guardrail (T-AC-2 / T-AC-2b) confirms no Postgres or
MySQL provider leaks into any of the 8 non-target-DB packages.
This package is in the "non-target-DB" set for both — it ships
neither provider in its `peerDependencies`.

---

## Wiring

Wire the adapter in two pieces in `AppModule.imports`: a host-
owned `PrismaClient` (created from the bundled or project-local
Prisma schema) and a `PrismaAdapter.forRoot()` carrier passed to
`NestBatchModule.forRoot({ adapters: { persistence, ... } })`.

### 1. Generate the Prisma client

Run this once against the bundled schema:

```bash
pnpm prisma generate --schema=packages/prisma/prisma/schema.prisma
```

Or, if you copy the schema into your project root, omit the
`--schema` flag.

### 2. Module wiring

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { PrismaAdapter, PrismaClient } from '@nest-batch/prisma';

@Module({
  imports: [
    NestBatchModule.forRoot({
      adapters: { persistence: PrismaAdapter.forRoot() },
    }),
  ],
  providers: [{ provide: PrismaClient, useValue: new PrismaClient() }],
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
(paired with `@nest-batch/postgresql`). Swap the `PrismaClient`
for a MySQL-backed one (and the schema for the one shipped in
`@nest-batch/mysql`) if you are running the MySQL pairing.

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

The Prisma implementation is exercised through the bundled
`@nest-batch/core/test-contracts` contract. If you change the
repository or transaction manager, run the contract suite to
confirm you haven't broken the contract. The end-to-end
testcontainers variant lives at `tests/e2e-postgres.test.ts` and
is gated by `RUN_PRISMA_E2E=1`:

```bash
RUN_PRISMA_E2E=1 pnpm --filter @nest-batch/prisma test -- tests/e2e-postgres.test.ts
```

The e2e variant runs `prisma migrate deploy` against the bundled
schema in a real Postgres container, then re-executes the contract
suite against the migrated database. It exists so a Prisma
migration regression surfaces in CI, not just the raw-SQL contract
test.

---

## Migration

The bundled Prisma schema lives at
`prisma/schema.prisma` (Postgres provider). The initial migration
is at `prisma/migrations/20250101000000_init/migration.sql`. Run
it with the standard Prisma CLI:

```bash
export DATABASE_URL=postgres://demo:demo@localhost:5434/nest_batch_demo
pnpm prisma migrate deploy --schema=packages/prisma/prisma/schema.prisma
# Dev only — edit the schema and generate a new migration:
pnpm prisma migrate dev --schema=packages/prisma/prisma/schema.prisma
```

`migrate deploy` is the production path; `migrate dev` is the dev
loop. The `@nest-batch/postgresql` driver sibling (T10a, follow-up
release) will own its own copy of this schema at
`packages/postgresql/prisma/schema.prisma`; apps that have already
adopted the driver sibling should run the migration from there
instead.

The Prisma migration runs against the same six Spring
Batch-compatible tables the MikroORM and TypeORM migrations
create. It uses `CREATE TABLE IF NOT EXISTS`, but column shapes
must match exactly across adapters.

---

## What is NOT in this package

- A DB driver. This package does not declare a Postgres or MySQL
  provider as a peer dep. The bundled `prisma/schema.prisma`
  ships a Postgres provider, but that schema moves to
  `@nest-batch/postgresql` in the follow-up release.
- A transport. Use `@nest-batch/bullmq` or `@nest-batch/kafka` to
  wire the execution strategy; the transport layer reads the
  same `JobExecution` rows.
- A MySQL adapter shell. Use `@nest-batch/mysql` and its bundled
  `prisma/schema.prisma` (`mysql` provider) for the MySQL pairing.
  This package does not ship a `mysql` provider.
- A migration runner. We use the Prisma CLI (`prisma migrate
  deploy` / `prisma migrate dev`); the package does not
  re-implement migration bookkeeping.
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
`RUN_PRISMA_E2E=1` and runs `prisma migrate deploy` against the
bundled schema in a real container before re-executing the
contract. If you change the repository or transaction manager,
run the e2e suite to confirm you haven't broken the contract.
