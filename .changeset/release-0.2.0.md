---
'@nest-batch/core': minor
'@nest-batch/mikro-orm': minor
'@nest-batch/typeorm': minor
'@nest-batch/drizzle': minor
'@nest-batch/prisma': minor
'@nest-batch/bullmq': minor
'@nest-batch/kafka': minor
'@nest-batch/postgresql': minor
'@nest-batch/mysql': minor
'@nest-batch/webhook': minor
---

Lockstep release of the 10-package `@nest-batch/*` family at 0.2.0.

This is a **breaking new major-structure release**. The previous single-package
`@nest-batch/nest-batch` is gone; the batch engine now lives in `@nest-batch/core`,
the persistence / transport integrations have moved into sibling packages, and
two new driver-sibling packages split Postgres and MySQL support apart. See
[`MIGRATION.md`](../../MIGRATION.md) for the full breakdown and
[`docs/RELEASE-0.2.0.md`](../../docs/RELEASE-0.2.0.md) for the integrated release
note.

## Highlights

- **Partition orchestration** across `@nest-batch/bullmq` and `@nest-batch/kafka`.
  Chunk steps with explicit partition configuration fan out one job per
  partition; the worker payload carries a `partitionIndex` field, the runtime
  service uses it to scope the partition cursor, and checkpoint / restart
  recover from the last-committed partition + chunk index.
- **3 new sibling packages:**
  - `@nest-batch/postgresql` — 4 Postgres adapter shells (MikroORM, TypeORM,
    Drizzle, Prisma) + the 6-table Postgres DDL migration + the bundled
    Postgres Prisma schema + the shared e2e harness against a real Postgres
    testcontainer.
  - `@nest-batch/mysql` — the MySQL mirror: 4 MySQL adapter shells, the
    6-table MySQL DDL migration, the bundled MySQL Prisma schema, and the e2e
    harness against a real MySQL 8.x testcontainer.
  - `@nest-batch/webhook` — `WebhookBatchObserver` that subscribes to the
    `BATCH_EVENT.*` lifecycle stream and POSTs HMAC-SHA256-signed JSON
    envelopes with exponential-backoff retry, dead-letter logging, and a
    hard "no retry on 4xx" rule. Native `fetch`, no HTTP client peer dep.
- **MySQL / Postgres driver separation.** The 4 DB adapter packages
  (`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/drizzle`,
  `@nest-batch/prisma`) are now **driver-agnostic adapter slots**; the
  Postgres shells and MySQL shells live in the new driver-sibling
  packages. The 8-package guardrail (T-AC-2 / T-AC-2b) fails the build if
  any Postgres or MySQL driver leaks into a non-target-DB package.
- **Drizzle / Kafka / Prisma stabilization** — promoted from "deferred" to
  stable members of the family. Each ships a per-package README, the
  `@nest-batch/core` contract suite, and the e2e test harness against a
  real testcontainer (gated by `RUN_DRIZZLE_E2E=1` / `RUN_KAFKA_E2E=1` /
  `RUN_PRISMA_E2E=1`).
- **Webhook observer** — Stripe-style signature header
  (`X-Nest-Batch-Signature: t=<unix>,v1=<hex-hmac-sha256>`), fixed
  `[1s, 5s, 25s, 125s]` retry schedule, secret never logged (asserted by
  T-AC-5 with a SHA-256 fingerprint on the dead-letter line).
- **Lockstep version policy.** All 10 packages are released in lockstep at
  0.2.0. The version check
  (`scripts/check-lockstep-version.js` / the inline node check) is the
  guardrail; mixed versions fail the build.

## Per-package deltas

The per-package changesets from T5-T11 (`drizzle-stabilize-0.2.0.md`,
`kafka-stabilize-0.2.0.md`, `prisma-stabilize-0.2.0.md`,
`mysql-sibling-0.2.0.md`, `webhook-sibling-0.2.0.md`) are kept alongside
this umbrella file and describe the per-package deltas in detail. They
will be consumed by the changesets tooling on release.
