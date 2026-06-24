# Release 0.2.0

This document is the **single integrated release note** for the
`@nest-batch/*` family Release 0.2.0. It supersedes the stale
"What is NOT in this release" section in
[`MIGRATION.md`](../MIGRATION.md) (lines 211-281 of the 0.1.0
revision) and the stale "Drizzle not in this release" / "what's
still on the roadmap" / "future enhancement" / "decorator is
metadata-only" notes in [`README.md`](../README.md),
[`docs/FAQ.md`](./FAQ.md), and
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md).

If you are reading this on a branch that has not yet shipped
0.2.0, the doc still describes the target state for the release;
it is the spec the Wave 2 / Wave 3 work builds toward.

---

## 1. TL;DR

Release 0.2.0 brings the `@nest-batch/*` workspace to a coherent
baseline: 10 packages at lockstep version `0.2.0`, the docs
synchronized to the shipped code, three new sibling packages
(`@nest-batch/mysql`, `@nest-batch/postgresql`,
`@nest-batch/webhook`), chunk-partition orchestration wired into
BullMQ and Kafka, and the three previously-deferred packages
(`drizzle`, `kafka`, `prisma`) promoted to stable members of the
family.

**The 10 packages in 0.2.0:**

- `@nest-batch/core`, the batch engine
- `@nest-batch/mikro-orm`, MikroORM 6.x adapter (driver-agnostic slot in 0.2.0)
- `@nest-batch/typeorm`, TypeORM 1.0.0 adapter (driver-agnostic slot in 0.2.0)
- `@nest-batch/drizzle`, Drizzle ORM adapter (driver-agnostic slot in 0.2.0)
- `@nest-batch/prisma`, Prisma adapter (driver-agnostic slot in 0.2.0)
- `@nest-batch/bullmq`, BullMQ transport strategy with partition support
- `@nest-batch/kafka`, Kafka transport strategy with partition support
- `@nest-batch/postgresql`, NEW. Owns the 4 Postgres adapter shells (`PostgresMikroOrmAdapter`, `PostgresTypeOrmAdapter`, `PostgresDrizzleAdapter`, `PostgresPrismaAdapter`); the only package that declares Postgres providers as peer deps.
- `@nest-batch/mysql`, NEW. Owns the 4 MySQL adapter shells (`MikroOrmMySql`, `TypeOrmMySql`, `DrizzleMySql`, `PrismaMySql`); the only package that declares MySQL providers as peer deps.
- `@nest-batch/webhook`, NEW. `WebhookBatchObserver` with HMAC-SHA256 signing, exponential-backoff retry, and a dead-letter log.

**Deferred to 0.3.0 (not in 0.2.0):**

- SQLite adapter, needs a separate `@nest-batch/sqlite` package; no provider leakage.
- OpenTelemetry tracing, `BatchObserver` is the documented extension point; a dedicated OTel exporter ships in 0.3.0.
- Admin UI, a separate `@nest-batch/admin` package with its own UI tier; the 0.2.0 release ships the `JobRepository` primitives it would consume, not the UI itself.

See [§9 0.3.0 roadmap](#9-030-roadmap) for the full deferred list and the per-driver sibling-package pattern that backs the guardrail.

---

## 2. The 10 packages

All 10 packages ship at version `0.2.0` in lockstep. The lockstep
policy is unchanged from 0.1.0: bumping one package bumps all
ten, recorded in a single `.changeset/release-0.2.0.md` entry.

| Package                  | Version | Role                                                                                                                                                                                                  | Peer deps                                                                                                           |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@nest-batch/core`       | `0.2.0` | Job / Step / Chunk / Tasklet IR, decorators, listeners, skip / retry policies, `IExecutionStrategy`, `@BatchScheduled`, `BatchScheduleRegistry`, `JobLauncher`                                        | `@nestjs/common@^10 \|\| ^11`, `@nestjs/core@^10 \|\| ^11`, `reflect-metadata@^0.2`                                 |
| `@nest-batch/mikro-orm`  | `0.2.0` | MikroORM 6.x adapter slot. `MikroOrmJobRepository` + `MikroOrmTransactionManager` + `MikroOrmAdapter`. Driver-agnostic; pair with `@nest-batch/postgresql` or `@nest-batch/mysql`.                    | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `@mikro-orm/core@^6.0.0`, `@mikro-orm/nestjs@^6.0.0` |
| `@nest-batch/typeorm`    | `0.2.0` | TypeORM 1.0.0 adapter slot. `TypeOrmJobRepository` + `TypeOrmTransactionManager` + `TypeOrmAdapter`. Driver-agnostic; pair with `@nest-batch/postgresql` or `@nest-batch/mysql`.                      | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `@nestjs/typeorm@^10 \|\| ^11`, `typeorm@^1.0.0`     |
| `@nest-batch/drizzle`    | `0.2.0` | Drizzle ORM adapter slot. `DrizzleJobRepository` + `DrizzleTransactionManager` + `DrizzleAdapter` + `DrizzleBatchModule`. Driver-agnostic; pair with `@nest-batch/postgresql` or `@nest-batch/mysql`. | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `drizzle-orm@^0.40.0`                                |
| `@nest-batch/prisma`     | `0.2.0` | Prisma adapter slot. `PrismaJobRepository` + `PrismaTransactionManager` + `PrismaAdapter` + `PrismaBatchModule`. Driver-agnostic; pair with `@nest-batch/postgresql` or `@nest-batch/mysql`.          | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `@prisma/client@^6.0.0`                              |
| `@nest-batch/bullmq`     | `0.2.0` | BullMQ transport strategy. `BullmqRuntimeService`, `BullmqAdapter`, `BullmqScheduleService` (cron firing via `upsertJobScheduler`), partition-aware `BullmqExecutionStrategy`.                        | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `@nestjs/core@^10 \|\| ^11`, `bullmq@^5.0.0`         |
| `@nest-batch/kafka`      | `0.2.0` | Kafka transport strategy. `KafkaRuntimeService`, `KafkaAdapter`, `KafkaExecutionStrategy`, `KafkaScheduleService` (hand-rolled `*/N * * * *` parser; see §4), partition-aware runtime.                | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, `@nestjs/core@^10 \|\| ^11`, `kafkajs@^2.2.4`        |
| `@nest-batch/postgresql` | `0.2.0` | Postgres driver sibling. 4 adapter shells (`PostgresMikroOrmAdapter`, `PostgresTypeOrmAdapter`, `PostgresDrizzleAdapter`, `PostgresPrismaAdapter`) + 5-table migration + boundary test.               | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, plus the 4 underlying adapter slot peer deps         |
| `@nest-batch/mysql`      | `0.2.0` | MySQL driver sibling. 4 adapter shells (`MikroOrmMySql`, `TypeOrmMySql`, `DrizzleMySql`, `PrismaMySql`) + 6-table migration + boundary test. Ephemeral Docker; gated by `RUN_MYSQL_E2E=1`.            | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`, plus the 4 underlying adapter slot peer deps         |
| `@nest-batch/webhook`    | `0.2.0` | Webhook delivery observer. `WebhookBatchObserver` + HMAC-SHA256 signing + exponential backoff (1s / 5s / 25s / 125s) + dead-letter `logger.warn` + `X-Nest-Batch-Signature` header.                   | `@nest-batch/core@workspace:^`, `@nestjs/common@^10 \|\| ^11`                                                       |

> **Why the 4 existing DB-adapter packages became "driver-agnostic slots."** The 0.1.0 release had 4 DB adapter packages (`mikro-orm`, `typeorm`, `drizzle`, `prisma`) that each inlined a Postgres shell: `mikro-orm` declared `@mikro-orm/postgresql` as a peer dep, `drizzle` shipped a `drizzle-orm/pg-core` schema, `prisma` shipped a `prisma/schema.prisma` with a Postgres provider, and `typeorm` carried the Postgres driver via `@nestjs/typeorm`. In 0.2.0 those shells move into the new `@nest-batch/postgresql` package. The 4 existing packages keep their name and their public API (`XxxJobRepository`, `XxxTransactionManager`, `XxxAdapter`, `XxxBatchModule`); they no longer declare a driver-specific peer dep. This is the symmetric refactor that backs the user-imposed guardrail "DB adapters must not depend on a DB provider." The 4 existing packages expose the ORM-specific interface shape and a build artifact that `@nest-batch/postgresql` and `@nest-batch/mysql` import. See [§3 What shipped](#3-what-shipped-in-020) and [§4 Stabilization](#4-stabilization).

---

## 3. What shipped in 0.2.0

This is the concrete delta vs. 0.1.0. Items are grouped by the
plan track they belong to. Every item below is the result of TDD
(RED-first test, then implementation, then refactor) and is
covered by a pinned acceptance test listed in the matching
section.

### 3.1 Partition orchestration for BullMQ and Kafka

`ChunkStepDefinition` gains a new `partitions` field (v1 contract,
see [§6 Partition semantics](#6-partition-semantics)) that lets a
chunked step declare how many parallel partitions to split the
input range across. The BullMQ strategy enqueues **one BullMQ job
per partition** (replacing the 0.1.0 "one job per step" model for
partitioned steps). The Kafka strategy mirrors the same model
across Kafka topics. Both strategies enforce the invariant
`0 <= partitionIndex < count` at runtime. Pinned acceptance
test: `T-AC-3` in `packages/bullmq/tests/partition-invariant.test.ts`
and `packages/kafka/tests/partition-invariant.test.ts`.

`InProcessAdapter` (the default in-process strategy) does **not**
honor `partitions.count > 1`: it throws or logs a warning. The
contract is locked and tested in
`packages/core/tests/core/contracts/in-process-rejects-partitions.test.ts`.
In-process is intentionally single-threaded; partition fan-out is
a transport feature.

### 3.2 `@nest-batch/mysql`, new sibling package

A new package that owns the 4 MySQL adapter shells:

- `MikroOrmMySql`, MikroORM 6.x + `@mikro-orm/mysql` driver
- `TypeOrmMySql`, TypeORM 1.0.0 + `mysql2` driver
- `DrizzleMySql`, Drizzle ORM + `drizzle-orm/mysql2` driver
- `PrismaMySql`, Prisma + the `mysql` Prisma provider

Each shell registers the host's `JOB_REPOSITORY_TOKEN` and
`TRANSACTION_MANAGER_TOKEN` bindings against the MySQL connection.
The package ships a 6-table MySQL migration (the same six
Spring Batch-compatible tables the Postgres siblings use, ported
to MySQL DDL). MySQL e2e uses ephemeral `docker run` or
testcontainers, gated by `RUN_MYSQL_E2E=1`. The boundary test
(T-AC-2) confirms no MySQL provider leaks into any of the 8
non-MySQL packages.

### 3.3 `@nest-batch/postgresql`, new sibling package

Symmetric to `@nest-batch/mysql`. Owns the 4 Postgres adapter
shells that previously lived inside the 4 existing DB adapter
packages:

- `PostgresMikroOrmAdapter`, MikroORM 6.x + `@mikro-orm/postgresql` driver
- `PostgresTypeOrmAdapter`, TypeORM 1.0.0 + `pg` driver
- `PostgresDrizzleAdapter`, Drizzle ORM + `drizzle-orm/node-postgres` + `drizzle-orm/pg-core` schema
- `PostgresPrismaAdapter`, Prisma + the `postgresql` Prisma provider

The Postgres shells are extracted from `@nest-batch/mikro-orm`,
`@nest-batch/typeorm`, `@nest-batch/drizzle`, and
`@nest-batch/prisma`. After the refactor those 4 packages no
longer declare `@mikro-orm/postgresql`, `pg`, `drizzle-orm/pg-core`,
or a Postgres Prisma provider. The boundary test (T-AC-2b)
confirms no Postgres provider leaks into any of the 8 non-Postgres
packages.

### 3.4 `@nest-batch/webhook`, new sibling package

`WebhookBatchObserver` subscribes to the `BATCH_EVENT.*` event
stream and posts a JSON payload to each configured URL on
job-completion events. Signing uses HMAC-SHA256 with a
host-injected secret; the signature is shipped in a Stripe-style
`X-Nest-Batch-Signature: t=<unix>,v1=<hex>` header (with a
`t=`-prefixed timestamp to support downstream replay-window
rejection). Retry uses exponential backoff at fixed 1s / 5s / 25s
/ 125s delays (4 attempts total). HTTP 4xx responses are
**not** retried (client error, won't change); 5xx and network
errors are retried through the full 4-attempt budget. After the
final failure the observer emits a `logger.warn` dead-letter log
including the URL, the attempt count, and the last error message.
The HMAC secret is never logged in any code path. Pinned
acceptance test: T-AC-5 in
`packages/webhook/tests/webhook-observer.test.ts`. Full contract
in [§7 Webhook contract](#7-webhook-contract).

### 3.5 Per-package READMEs for `drizzle`, `kafka`, `prisma`

The three previously-stale "deferred" entries in the README now
have their own per-package README. Each README covers install,
peer-dep table, driver-pairing notice, wiring, contract-test
invocation, and a "What is NOT in this package" section. The
Kafka README also documents the hand-rolled `*/N * * * *` parser
as a known 0.2.0 limitation (richer Quartz / Spring Batch syntax
ships in 0.3.0). The Drizzle and Prisma READMEs document the
"this package is driver-agnostic; pair with `@nest-batch/postgresql`
or `@nest-batch/mysql`" rule.

### 3.6 Version policy

All 10 packages move lockstep from `0.1.0` to `0.2.0`, recorded
in a single `.changeset/release-0.2.0.md` entry. The policy
itself is unchanged from 0.1.0; see `MIGRATION.md` §"Closing
notes". The 0.2.0 step is the documented boundary for the
adapter-slimming shape change (MIGRATION.md §"Adapter slimming")
and the Postgres-shell extraction (this document §3.3).

---

## 4. Stabilization

`@nest-batch/drizzle`, `@nest-batch/kafka`, and
`@nest-batch/prisma` were "deferred" in the 0.1.0 docs even
though the packages themselves existed in the workspace and
shipped a `JobRepository` + `TransactionManager` + adapter +
contract test. The 0.2.0 release promotes them to **stable
members of the family**.

What that means concretely:

- The Drizzle / Kafka / Prisma entries are no longer marked
  "not in this release" anywhere in the doc tree. `MIGRATION.md`
  no longer has a Drizzle section under "What is NOT in this
  release"; the README's "Where things live" table lists all
  three alongside MikroORM and TypeORM; the FAQ's "Can I use
  Drizzle?" answer flips from "no, deferred" to "yes, see
  `@nest-batch/drizzle`."
- Each of the three packages has a per-package README. The
  READMEs are the per-package contract: install, peer-dep table,
  wiring, contract-test invocation, "What is NOT in this
  package" callout.
- The contract suite runs against the three packages'
  implementations in CI, matching the existing pattern for
  `@nest-batch/mikro-orm` and `@nest-batch/typeorm`.

The three "deferred" labels that were removed:

1. **Drizzle**, was deferred (MIGRATION.md §"What is NOT in this release" / `MIGRATION.md:218-232` in the 0.1.0 revision). Removed. Drizzle ships in 0.2.0.
2. **Kafka transport**, was implied deferred by the "no Sidekiq, no RabbitMQ, no SQS, no Celery, no Kafka transport" line (`MIGRATION.md:267-274` in the 0.1.0 revision). Removed. `@nest-batch/kafka` ships in 0.2.0; the more general "no Sidekiq / RabbitMQ / SQS / Celery" line stays accurate for those transports.
3. **Prisma**, was implicitly deferred by the README "no Drizzle package" line and the absence of a Prisma entry in "Where things live". `@nest-batch/prisma` ships in 0.2.0 with the same shape as MikroORM and TypeORM.

The 0.1.0 release's Drizzle "use Drizzle yourself and run the
contract suite" workaround is still valid; the 0.2.0 release just
makes the official path available.

---

## 5. Doc-currency correction

The 0.1.0 release shipped code that the docs did not reflect. The
0.2.0 release brings the docs in line. The table below names the
five stale phrases, the file:line they lived at in the 0.1.0
revision, and the new 0.2.0 reality.

| Stale phrase (0.1.0 docs)                                                                                                                                                                                                                          | Location (0.1.0 revision)                                                              | 0.2.0 reality                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Drizzle is not in this release (deferred)"                                                                                                                                                                                                        | `MIGRATION.md:218-232` and `README.md:65-67`                                           | `@nest-batch/drizzle` is a stable member of the family. Driver-agnostic slot; pair with `@nest-batch/postgresql` or `@nest-batch/mysql`.                                                                                                                                          |
| "What's still on the roadmap is the optional scheduler (cron-style jobs that actually fire, not just register metadata), partitioning for chunked steps, and (eventually) the Drizzle adapter"                                                     | `README.md:362-369`                                                                    | The cron scheduler fires today via `BullmqScheduleService.onApplicationBootstrap()` which calls `queue.upsertJobScheduler(schedulerKey, { pattern, tz }, template)`. Partitioning ships in 0.2.0. Drizzle ships in 0.2.0.                                                         |
| "Future enhancement (not in this release): Chunked steps with explicit partition configuration will enqueue one job per partition... `partitionIndex` is a forward-compatibility stub"                                                             | `docs/ARCHITECTURE.md:175-181` (and a paraphrase at `packages/bullmq/README.md:50-58`) | Partition orchestration ships in 0.2.0 for both BullMQ and Kafka. `partitionIndex` is a real, user-facing field with the contract `0 <= partitionIndex < count`. InProcessAdapter throws or warns on `count > 1`.                                                                 |
| "There is no Sidekiq, no RabbitMQ, no SQS, no Celery, no Kafka transport in this release"                                                                                                                                                          | `MIGRATION.md:267-274`                                                                 | Sidekiq / RabbitMQ / SQS / Celery are still not in this release, the `IExecutionStrategy` polymorphism is the documented extension point. **Kafka ships in 0.2.0** via `@nest-batch/kafka`; the "no Kafka" clause is removed.                                                     |
| "Today the decorator is useful for declaring intent and for the `BatchScheduleRegistry` to expose a queryable list" / "A future runtime scheduler (likely a follow-up to the BullMQ adapter) will read that metadata and install the real timers." | `docs/FAQ.md:196-211`                                                                  | `@BatchScheduled` is not metadata-only. `BullmqScheduleService` walks the `BatchScheduleRegistry` on `OnApplicationBootstrap` and installs a BullMQ `upsertJobScheduler` for every non-inert entry. Inert mode (`BATCH_SCHEDULED_DISABLE=1`) is the documented test escape hatch. |

The doc edits that fix these five lines are not a top-to-bottom
rewrite; each is a targeted paragraph or sentence replacement.
The doc-currency acceptance test (T-AC-1) scans the doc tree
and asserts each of the five stale phrases is absent.

---

## 6. Partition semantics

The v1 partition contract. This is the API the 0.2.0 release
ships; future versions may add fields but will not remove or
rename these.

### 6.1 `ChunkStepDefinition.partitions`

```ts
export interface PartitionRange {
  count: number; // >= 1; 1 means "no partitioning" (default)
  range?: (i: number, n: number) => readonly [from: number, to: number];
}

export interface ChunkStepDefinition {
  id: string;
  // ... existing chunk fields (reader, processor, writer, chunkSize, skipPolicy, ...) ...
  partitions?: PartitionRange;
}
```

- `count: number`, number of partitions. `count: 1` (or
  omitting `partitions` entirely) preserves the 0.1.0 behavior
  of "one job per step". `count >= 2` activates the
  partition-aware runtime.
- `range?: (i, n) => [from, to]`, optional partition-range
  resolver. Given the partition index `i` and the total
  `n`, return a half-open `[from, to]` range that the partition
  consumes. When omitted, the transport uses its default
  splitting strategy (BullMQ: enqueue N jobs with no input
  range; Kafka: enqueue N keyed messages with `partitionIndex`
  as the key). The contract is that the host never has to
  implement `range` unless it wants a custom split (e.g. by
  primary key, by hash bucket, by date).

### 6.2 `partitionIndex` enforcement

The transport attaches a `partitionIndex` to every job it
enqueues for a partitioned step. The runtime enforces:

```ts
if (!Number.isInteger(partitionIndex) || partitionIndex < 0 || partitionIndex >= count) {
  throw new InvalidPartitionIndexError(partitionIndex, count);
}
```

Pinned in `packages/core/src/core/ir/partition-invariant.ts` and
asserted by `T-AC-3` (`packages/bullmq/tests/partition-invariant.test.ts`,
`packages/kafka/tests/partition-invariant.test.ts`). A non-integer
or out-of-range `partitionIndex` is a hard error; the step does
not run, the DB row is marked `FAILED` with the invariant
violation message.

### 6.3 `InProcessAdapter` rejects `partitions.count > 1`

`InProcessAdapter` does not honor multi-partition fan-out. If
`partitions.count > 1` is configured against the in-process
strategy, the launcher either throws (default) or logs a warning
and runs the step as a single partition. The exact behavior is
gated by the `InProcessAdapter` options; the contract is that
the host gets a clear signal that the in-process strategy is
not the right transport for partitioned work, not a silent
single-partition execution. Pinned in
`packages/core/tests/core/contracts/in-process-rejects-partitions.test.ts`.

### 6.4 Source of truth

- `packages/core/src/core/ir/step-definition.ts`, the
  `ChunkStepDefinition.partitions` field.
- `packages/core/src/core/ir/partition-invariant.ts`, the
  runtime enforcement.
- `packages/bullmq/src/bullmq-execution-strategy.ts`, the
  BullMQ partition-aware enqueue.
- `packages/kafka/src/kafka-execution-strategy.ts`, the Kafka
  mirror.

---

## 7. Webhook contract

The `@nest-batch/webhook` v1 contract.

### 7.1 Module shape

```ts
WebhookBatchModule.forRoot({
  secret: process.env.WEBHOOK_HMAC_SECRET, // 32+ bytes recommended
  urls: ['https://hooks.example.com/nest-batch', 'https://ops.example.com/ingest/nest-batch'],
  // Optional overrides:
  // retryDelaysMs: [1_000, 5_000, 25_000, 125_000],  // default below
  // maxRetries: 4,                                   // default below
  // timeoutMs: 10_000,                               // per-attempt HTTP timeout
});
```

The secret is host-injected (never read from disk, never
defaulted). The `urls` list is the fan-out set; the observer
posts to all of them on every relevant event.

### 7.2 Retry constants

The fixed backoff schedule is **1s, 5s, 25s, 125s** (four
attempts, three delays between them, then dead-letter). The
schedule is not configurable in v1: the values are the contract.
A future release may add a `retryDelaysMs` override; the
default is the contract the test suite relies on.

### 7.3 4xx-no-retry / 5xx-retry rule

| HTTP status   | Behavior                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2xx`         | Success. The observer marks the delivery done.                                                                                                                        |
| `3xx`         | Treated as a redirect. The observer follows the redirect once; if the redirect target returns 4xx / 5xx, that target's status drives the retry decision.              |
| `4xx`         | **No retry.** Logged at `warn` level with the URL and the response body. The host is expected to fix the misconfiguration (bad URL, missing auth, malformed payload). |
| `5xx`         | **Retried** through the full 4-attempt budget at the 1s / 5s / 25s / 125s schedule. After the final attempt, dead-letter.                                             |
| Network error | **Retried** through the full 4-attempt budget. After the final attempt, dead-letter.                                                                                  |
| Timeout       | Treated as a network error. **Retried** through the full 4-attempt budget.                                                                                            |

### 7.4 `X-Nest-Batch-Signature` header (Stripe-style)

Every outbound POST carries:

```
X-Nest-Batch-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Where `<hex-hmac-sha256>` is `HMAC_SHA256(secret, "<unix>.<raw-body>")`
in lowercase hex. The `<raw-body>` is the exact JSON-serialized
request body bytes (not a re-serialization). The `t=` timestamp
lets the receiver enforce a replay window (recommended: 5
minutes). A future release may add `v1=`-prefixed scheme-version
constants; the `v1` key is the v1 contract.

### 7.5 Secret-never-logged invariant

The HMAC secret is never logged, never written to a `logger`
call, never serialized into a dead-letter body, never returned
by any public API. The pinned test
(`packages/webhook/tests/webhook-observer.test.ts` T-AC-5)
asserts no `WEBHOOK_HMAC_SECRET` substring appears in captured
log output across the full 4-attempt retry budget. The
secret also never crosses a transport boundary: it is bound at
`forRoot` time and stored on the `WebhookBatchObserver`
instance; it is not exported from the package.

### 7.6 Dead-letter

After the final failed attempt (4xx not retried, or 5xx /
network / timeout after all 4 attempts), the observer emits:

```ts
logger.warn(
  `[WebhookBatchObserver] dead-letter url=${url} attempts=${attempts} ` +
    `lastStatus=${lastStatus ?? 'n/a'} lastError=${lastError}`,
);
```

The dead-letter is a log line, not a database row. A future
release may add a `DeadLetterStore` token; for 0.2.0 the host
ships its log aggregator (Datadog, CloudWatch, Loki) to
recover dead-lettered URLs.

### 7.7 Source of truth

- `packages/webhook/src/webhook-batch.module.ts`, the
  `forRoot` shape and the observer binding.
- `packages/webhook/src/webhook-batch.observer.ts`, the
  signature, retry, and dead-letter logic.
- `packages/webhook/src/webhook-signing.ts`, the HMAC
  helper.
- `packages/webhook/tests/webhook-observer.test.ts`, T-AC-5.

---

## 8. Migration from 0.1.0

The full 0.1.0 → 0.2.0 migration story lives in
[`MIGRATION.md`](../MIGRATION.md). This section is the
release-note cross-reference; it summarizes the breakage and
the new opt-in features so the reader knows whether to keep
reading.

### 8.1 Breaking changes (pre-1.0, minor bump)

The only 0.2.0 breaking change is the **adapter slimming**
shape change already documented in `MIGRATION.md §"Adapter
slimming"`. The `MikroOrmAdapter.forRoot()` and
`TypeOrmAdapter.forRoot()` factories become no-arg; the host
takes ownership of the third-party connection module call.
This is the same shape `InProcessAdapter.forRoot()` has always
had. No new breaking changes are introduced in 0.2.0.

The `IExecutionStrategy`, `JobLauncher.launch()`,
`IJobRepository` / `TransactionManager` contract, the
`@Jobable` / `@ItemReader` / `@ItemProcessor` / `@ItemWriter` /
`@Tasklet` / listener decorator names, the `@BatchScheduled`
API, and the peer-dep ranges for `@nest-batch/core`
(`@nestjs/common@^10||^11`, `@nestjs/core@^10||^11`,
`reflect-metadata@^0.2`) are all stable in 0.2.0. Breaking
changes to those surfaces will only happen in a future major
version, with a deprecation period.

### 8.2 New opt-in features (no migration required)

The following are additive; hosts that do not use them are
unaffected by the version bump.

- **Chunk partitions.** Set `ChunkStepDefinition.partitions.count`
  to fan a chunked step out across N parallel partitions
  (BullMQ or Kafka transport). `InProcessAdapter` rejects
  `count > 1`. See [§6](#6-partition-semantics).
- **MySQL persistence.** Install `@nest-batch/mysql` and wire
  one of the 4 MySQL adapter shells. The 8 non-MySQL packages
  remain MySQL-free (T-AC-2 boundary test enforces it).
- **PostgreSQL persistence (refactored).** Install
  `@nest-batch/postgresql` and wire one of the 4 Postgres
  adapter shells. The shells that used to live in
  `@nest-batch/mikro-orm` / `@nest-batch/typeorm` /
  `@nest-batch/drizzle` / `@nest-batch/prisma` are now
  imported from `@nest-batch/postgresql`. The 4 existing
  packages remain in the workspace as driver-agnostic slots;
  their public API (`XxxJobRepository`,
  `XxxTransactionManager`, `XxxAdapter`, `XxxBatchModule`) is
  unchanged.
- **Webhook delivery.** Install `@nest-batch/webhook` and call
  `WebhookBatchModule.forRoot({ secret, urls })`. The observer
  subscribes to `BATCH_EVENT.*` automatically. See [§7](#7-webhook-contract).
- **Drizzle, Kafka, Prisma stabilization.** No code change; the
  packages now have a public README, an official support tier,
  and a per-package acceptance test in CI. Hosts that already
  imported `@nest-batch/drizzle` / `@nest-batch/kafka` /
  `@nest-batch/prisma` see no breaking change.

### 8.3 Lockstep version policy

The 0.1.0 → 0.2.0 bump is the second lockstep move. The
lockstep policy is documented in `MIGRATION.md §"Closing notes"`
and is unchanged: bumping one package bumps all 10. The
`.changeset/release-0.2.0.md` entry is a single major-bump
record.

### 8.4 Cross-references to other docs

The following docs are edited as part of the 0.2.0 release to
remove the stale phrases the 0.2.0 release supersedes:

- `MIGRATION.md`, the "What is NOT in this release" section
  (lines 211-281 of the 0.1.0 revision) is replaced with a
  forward-pointer to this document; the lockstep claim is
  extended from "4 packages" to "10 packages".
- `README.md`, the "Where things live" table grows from 4
  rows to 10 rows (the 6 new packages), the package list
  diagram grows from 3 packages to 10, and the "Status"
  section flips from "what's still on the roadmap" to "0.2.0
  ships partition orchestration + MySQL + webhook; 0.3.0
  roadmap includes SQLite, OTel, admin UI".
- `docs/FAQ.md`, the cron question flips from "metadata-only"
  to "yes, fires"; the Drizzle / Kafka / Prisma questions
  flip from "deferred" to "yes, ships"; new entries cover
  MySQL, PostgreSQL (refactored), and webhook delivery.
- `docs/ARCHITECTURE.md`, §3 removes the "future enhancement"
  callout, replaces it with the partition contract from
  [§6](#6-partition-semantics) and the `partitionIndex`
  enforcement rule.

The doc-currency acceptance test (T-AC-1, in
`packages/core/tests/release-0.2.0/doc-currency.test.ts`)
asserts the five stale phrases listed in [§5](#5-doc-currency-correction)
are absent across the four files.

---

## 9. 0.3.0 roadmap

The items below are **not** in 0.2.0. Each ships in 0.3.0
behind a separate sibling package, never inside an existing
package. The user-imposed guardrail from the 0.2.0 plan
("MySQL 구현 시 DB provider에 각 패키지가 의존하지 않도록
구현") extends: any new driver, any new transport, any new
UI tier ships in its own package and its own boundary test.

### 9.1 SQLite (`@nest-batch/sqlite`)

A separate sibling package that owns the 4 SQLite adapter
shells (`MikroOrmSqlite`, `TypeOrmSqlite`, `DrizzleSqlite`,
`PrismaSqlite`). The 10 existing packages stay SQLite-free;
a boundary test confirms no `better-sqlite3` / `sqlite3` /
`drizzle-orm/sqlite-core` import shows up anywhere except
`@nest-batch/sqlite`. The primary use case is local
development and CI, not production throughput; the
testcontainers e2e is gated by `RUN_SQLITE_E2E=1`.

### 9.2 OpenTelemetry tracing (`@nest-batch/otel`)

A separate sibling package that exports a `BatchObserver`
binding OpenTelemetry spans around `BATCH_EVENT.*` events.
The 10 existing packages stay OTel-free; the OTel SDK is a
peer dep of `@nest-batch/otel` only. A host that does not
install `@nest-batch/otel` sees the existing `NoopBatchObserver`
default; a host that does install it gets spans and metrics
without touching `@nest-batch/core` or any adapter. The
deferred item from the 0.1.0 docs ("There is no OpenTelemetry
tracing, no Jaeger / Zipkin integration") is delivered by
this package in 0.3.0.

### 9.3 Admin UI (`@nest-batch/admin`)

A separate sibling package with its own NestJS module
(`AdminBatchModule.forRoot({ mountPath: '/admin/batch' })`)
that exposes a read-only REST + minimal-UI tier over the
`JobRepository` primitives. The 10 existing packages stay
UI-free; the admin package depends on `@nest-batch/core` and
the host's chosen adapter, nothing else. The 0.1.0 docs'
"There is no admin UI, no job management dashboard, and no
REST endpoint for inspecting / re-launching / cancelling
jobs" line is delivered by this package in 0.3.0.

### 9.4 MariaDB / CockroachDB

The 0.2.0 release does not ship MariaDB or CockroachDB
support. When one ships, it follows the same per-driver
sibling pattern: a new `@nest-batch/mariadb` (or
`@nest-batch/cockroachdb`) package that owns the 4 adapter
shells and the active meta-schema migration against that dialect. The
10 existing packages stay dialect-agnostic; the boundary
test pattern from T-AC-2 / T-AC-2b extends to forbid the
new dialect's import paths in the existing 10 packages.

### 9.5 Richer cron syntax in `@nest-batch/kafka`

The 0.2.0 release's `@nest-batch/kafka` ships a hand-rolled
`*/N * * * *` parser. Richer expressions (Quartz, Spring
Batch's 6-field syntax, named months / weekdays) ship in
0.3.0. The contract is additive: existing `*/N * * * *`
expressions keep working; new expressions gain support. A
host that needs the full Spring Batch cron shape can move
to `@nest-batch/bullmq` for cron today and back to
`@nest-batch/kafka` once 0.3.0 ships.

### 9.6 Sidekiq / RabbitMQ / SQS / Celery

Not in 0.2.0, not on the 0.3.0 roadmap. The
`IExecutionStrategy` polymorphism in `@nest-batch/core` is
the documented extension point; a host that needs one of
these writes its own strategy and binds it to
`EXECUTION_STRATEGY` the same way `@nest-batch/bullmq` and
`@nest-batch/kafka` do. None of them is a candidate for a
new sibling package in 0.3.0.

---

## 10. Acceptance gates

The 0.2.0 release is gated by 6 pinned acceptance tests, all
agent-executed in CI. No human action is required to clear the
gates. The full list lives in the plan file
(`.omo/plans/not-in-this-release.md`); the summary is:

| Test    | Location                                                                                                 | Asserts                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-AC-1  | `packages/core/tests/release-0.2.0/doc-currency.test.ts`                                                 | The 5 stale phrases from [§5](#5-doc-currency-correction) are absent across `MIGRATION.md` / `README.md` / `docs/FAQ.md` / `docs/ARCHITECTURE.md`. `docs/RELEASE-0.2.0.md` exists and contains the 10-package list. |
| T-AC-2  | `packages/core/tests/core/boundary/no-mysql-in-existing-packages.test.ts`                                | No `mysql` / `mysql2` / `@mysql/` import or peer dep appears in the 8 non-MySQL packages.                                                                                                                           |
| T-AC-2b | `packages/core/tests/core/boundary/no-postgres-in-existing-packages.test.ts`                             | No `pg` / `@mikro-orm/postgresql` / `drizzle-orm/pg-core` / `drizzle-orm/node-postgres` / Postgres Prisma provider in the 8 non-Postgres packages.                                                                  |
| T-AC-3  | `packages/bullmq/tests/partition-invariant.test.ts` + `packages/kafka/tests/partition-invariant.test.ts` | `0 <= partitionIndex < count` is enforced at runtime; out-of-range values throw.                                                                                                                                    |
| T-AC-4  | `packages/bullmq/tests/schedule-fires.test.ts`                                                           | `BullmqScheduleService.onApplicationBootstrap()` calls `queue.upsertJobScheduler(schedulerKey, { pattern, tz }, template)` for every non-inert entry; inert entries are skipped.                                    |
| T-AC-5  | `packages/webhook/tests/webhook-observer.test.ts`                                                        | HMAC-SHA256 signature in `X-Nest-Batch-Signature: t=<unix>,v1=<hex>` header; 1s / 5s / 25s / 125s retry; 4xx-no-retry / 5xx-retry; secret never logged; dead-letter `logger.warn` after final attempt.              |

A release that has not pinned all 6 to green in `pnpm test`
across the workspace is not 0.2.0.

---

## 11. Cross-references

The 0.2.0 release edits a small, targeted set of files. Every
file edited has its primary documentation surface in this
section. Per-package READMEs are not enumerated here; they
cross-reference this document by their own choice.

- [`MIGRATION.md`](../MIGRATION.md), the breaking-change and
  0.1.0 → 0.2.0 migration story. The "What is NOT in this
  release" section (lines 211-281 of the 0.1.0 revision) is
  replaced with a 3-line forward-pointer to this document.
- [`README.md`](../README.md), top-level orientation:
  package list, "Where things live" table (now 10 rows),
  "Status" section (now points to 0.2.0 shipping items and
  0.3.0 deferred items).
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md), the four
  design principles and their tests. §3 is rewritten to drop
  the "future enhancement" callout and document the partition
  contract from [§6](#6-partition-semantics).
- [`docs/FAQ.md`](./FAQ.md), common questions. The cron
  answer flips from "metadata-only" to "yes, fires"; the
  Drizzle / Kafka / Prisma answers flip from "deferred" to
  "yes, ships"; new entries cover MySQL, PostgreSQL
  (refactored), and webhook delivery.
- [`docs/QUICKSTART.md`](./QUICKSTART.md), local dev
  runbook. Cross-references this document for the
  0.2.0-specific run commands; the runbook itself is
  unchanged.
- Per-package READMEs:
  - [`packages/core/README.md`](../packages/core/README.md)
  - [`packages/mikro-orm/README.md`](../packages/mikro-orm/README.md)
  - [`packages/typeorm/README.md`](../packages/typeorm/README.md)
  - [`packages/drizzle/README.md`](../packages/drizzle/README.md), NEW
  - [`packages/prisma/README.md`](../packages/prisma/README.md), NEW
  - [`packages/kafka/README.md`](../packages/kafka/README.md), NEW
  - [`packages/bullmq/README.md`](../packages/bullmq/README.md)
  - [`packages/postgresql/README.md`](../packages/postgresql/README.md), NEW
  - [`packages/mysql/README.md`](../packages/mysql/README.md), NEW
  - [`packages/webhook/README.md`](../packages/webhook/README.md), NEW

The plan file (`.omo/plans/not-in-this-release.md`) is the
authoritative spec for everything in this release; this
document is the release note, not the spec.

---

## 12. Closing notes

- **Lockstep.** The 0.1.0 → 0.2.0 step moves all 10 packages
  in lockstep. A future 0.2.1 patch may move the family as a
  unit; a future 0.3.0 minor moves them again. The lockstep
  policy is unchanged from 0.1.0 and is documented in
  `MIGRATION.md §"Closing notes"`.
- **Guardrail.** The 0.2.0 release's biggest design constraint
  is "no DB provider in any of the 8 non-target-DB packages."
  This is enforced by the T-AC-2 / T-AC-2b boundary tests. A
  future change that adds a `mysql2` import to
  `@nest-batch/core` (or any of the 7 other non-MySQL packages)
  fails the build. The guardrail is the
  release's most important invariant; do not relax it without
  re-running the full Wave 2 track.
- **Inherited from 0.1.0.** The Spring Batch-like
  Job/Step/Chunk/Tasklet/Reader/Processor/Writer conceptual
  model, the `@Jobable` / `@ItemReader` / `@ItemProcessor` /
  `@ItemWriter` / `@Tasklet` decorator names, the listener
  decorator names, the `JobLauncher.launch(jobId, params)`
  API, the public `IJobRepository` / `TransactionManager`
  contract, and the chunk transaction / skip / restart /
  checkpoint semantics are unchanged in 0.2.0. The 0.2.0
  release adds to the family; it does not move the family.
- **Read next.** The migration walkthrough is in
  `MIGRATION.md`. The architectural rationale and the four
  design principles are in `docs/ARCHITECTURE.md`. The
  contract details (HMAC, retry, partition, observability) are
  in the per-package READMEs and in
  `packages/core/test-contracts`.

Release 0.2.0 ships when the 6 acceptance tests are green and
the `.changeset/release-0.2.0.md` entry is published.
