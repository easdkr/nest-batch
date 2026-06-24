# FAQ

Common questions about the `@nest-batch/*` family. The answers
point to the package, file, or test that proves the behavior, not
to aspirational docs. If a question is missing, open an issue.

For the **what is and isn't in this release** list, see
[`MIGRATION.md`](../MIGRATION.md). For the design principles behind
the answers below, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Core engine

### Why is my BullMQ job not seeing chunked items?

Chunking happens in `@nest-batch/core`, not in `@nest-batch/bullmq`.
The BullMQ adapter enqueues **one BullMQ job per step**, and the
worker runs the read → process → write loop inside that one job.
BullMQ never sees individual items or chunks; it only sees step
metadata.

If your consumer needs the items, look in the step's reader /
processor / writer instead of the BullMQ job's `data` field. The
test in `packages/bullmq/tests/...` asserts the `step.id` is the
BullMQ `name` and the worker payload carries only step-scoped
metadata, not item data.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#3-step--partition-is-the-unit-of-work-row--chunk--item-never-is)
for the principle.

### Why is `@nest-batch/core` so dependency-light?

By design. Core is the batch engine; it should be installable into
any project that already has NestJS, regardless of database or
queue choice. The framework peer dependency surface is
`@nestjs/common`, `@nestjs/core`, and `reflect-metadata`; core also
depends on the small `cron` package for the built-in in-process
schedule bridge.

A boundary test in
`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`
fails the build if any of `bullmq`, `mikro-orm`, `typeorm`,
or `drizzle-orm` shows up as an import inside core's `src/`. That
test is the canary for keeping transport and ORM integrations out of
core.

### Where does the canonical `JobExecution` state live?

In the configured `JobRepository` — that is, in the database
backing the adapter you wired. With `@nest-batch/mikro-orm` that is
PostgreSQL via the `batch_job_execution` table. With
`@nest-batch/typeorm` it is the same six tables, expressed as
TypeORM 1.0.0 entities. The core package ships an in-memory
reference implementation that is useful for tests, but a real host
should never run production traffic against the in-memory store.

The DB row is canonical. A BullMQ job is a correlation stamp, not a
state row. If Redis loses the queue, the DB row is unaffected; if a
worker crashes, the DB row stays in `STARTED` and the recovery path
picks it up. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md#2-the-database-is-the-canonical-source-of-execution-state).

### How do I run the contract suite against my own adapter?

Import the contract suite from `@nest-batch/core/test-contracts` and
call the runner against your `JobRepository` and `TransactionManager`
implementations. The suite covers idempotent instance creation,
atomic execution creation, running-execution guards, optimistic
concurrency on `execution_context`, restart / checkpoint lookup,
and transactional wrap / commit / rollback / nested.

The `@nest-batch/mikro-orm` and `@nest-batch/typeorm` e2e tests are
the reference for how to wire the suite. See
`packages/mikro-orm/tests/contract.test.ts` and the equivalent
file in the typeorm package.

### The `JobLauncher.launch` API returned `STARTING` instead of `COMPLETED`. Is that a bug?

No. The `EXECUTION_STRATEGY` is bound to the BullMQ transport, and
the launcher's response reflects the durable DB row, which is
written before the worker has had a chance to consume the queue.
The `status: 'STARTING'` is correct. Poll the `JobRepository` (or
your own admin endpoint) for the terminal state, or use the
in-process strategy if you want the launcher's response to block
until the executor finishes.

---

## Adapters

### Can I use Drizzle?

Not in this release. There is no `@nest-batch/drizzle` package, and
the `drizzle-orm` import is on the boundary test's forbidden list
for core. The Drizzle adapter is **deferred** (not refused); if you
have a strong use case, file an issue.

If you need a Drizzle adapter today, write a `JobRepository` and
`TransactionManager` against Drizzle yourself and run the
`@nest-batch/core/test-contracts` against it. The contract suite
proves the adapter satisfies the family contract; the rest of
`@nest-batch/core` (engine, decorators, listeners, skip / retry
policies) does not know or care which DB you used.

### Can I use TypeORM 0.3?

No. `@nest-batch/typeorm` targets TypeORM **1.0.0 only** and the
peer range is hard-pinned to `^1.0.0`. The `Connection → DataSource`
rename makes 0.3 support expensive to maintain; the
`typeorm@^1.0.0` peer range is documented as locked.

If you are on 0.3, stay on the previous `@nest-batch/nest-batch`
package (pre-rename) or upgrade TypeORM first. There is no
`@typeorm/0.3-compat` shim in this release.

### Can I use MikroORM 5?

No. `@nest-batch/mikro-orm` targets **MikroORM 6.x only** and the
peer ranges (`@mikro-orm/core`, `@mikro-orm/nestjs`,
`@mikro-orm/postgresql`) are hard-pinned to `^6.0.0`. The boundary
test in core and a dedicated peer-range test in
`@nest-batch/mikro-orm` together ensure 5.x does not silently sneak
back in.

### Do the two adapter packages share the same schema?

Yes. The active schema is the same 5-table shape across the ORM
adapters and driver siblings: `batch_job_instance`,
`batch_job_execution`, `batch_step_execution`,
`batch_job_execution_context`, and `batch_step_execution_context`.
For MikroORM, the entity classes live in `@nest-batch/mikro-orm`;
driver siblings provide the matching dialect-specific DDL/schema
carriers.

A host can switch from one adapter to the other by running the
target adapter's migration and rebinding the `JobRepository` /
`TransactionManager` providers. The application code above the
adapter does not change.

---

## BullMQ transport

### Why is the BullMQ transport in a separate package?

Because BullMQ is the transport, not the engine. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md#1-bullmq-is-the-transport-runtime-not-the-batch-engine)
for the principle. Keeping it in a sibling package means
`@nest-batch/core` can stay dependency-light, and a host that wants
a different transport (Sidekiq, RabbitMQ, SQS, ...) writes its own
`IExecutionStrategy` the same way.

### Why are producer and worker Redis clients configured differently?

BullMQ is opinionated about which Redis options are safe for the
producer (the `Queue`) versus the consumer (the `Worker` /
`QueueEvents`). The package applies the split transparently based
on the role it is building:

- Workers: `maxRetriesPerRequest: null` and
  `enableReadyCheck: false` are mandatory. BullMQ's internal
  blocking commands must not retry per request; a stalled worker
  should surface as a stalled job, not a connection error.
- Producers: `enableOfflineQueue: false` and
  `maxRetriesPerRequest: 1`. A Redis-down condition must raise an
  error synchronously on the enqueue call so the `JobLauncher`
  propagates the failure to the caller.

You should not need to override either set. The defaults are the
contract the test suite relies on. See
[`packages/bullmq/README.md`](../packages/bullmq/README.md#connection-policy-worker-vs-producer)
for the full table.

### How is the BullMQ queue name picked?

The BullMQ adapter uses the step's `id` from the `JobDefinition` as
the BullMQ `name` discriminator. One BullMQ job per step, regardless
of input row count. All keys are prefixed with `nest-batch:` (or
the override passed via `BullMqConnectionOptions.keyPrefix`), so
sharing a Redis instance with other applications is safe.

### What happens if the worker crashes mid-step?

The `batch_step_execution` row stays in `STARTED` (or whatever
state it was in) and the corresponding `batch_job_execution` row
records the in-flight status. On restart, `findLatestStepExecution`
returns the most recent `StepExecution` for
`(jobExecutionId, stepName)` regardless of status, so the executor
loads the last-committed chunk index from
`batch_step_execution_context` and resumes from there. The
in-flight BullMQ job's `attempts` count is consumed by BullMQ's
own retry policy; a crash counts as one attempt.

---

## Scheduling

### Does `@BatchScheduled` actually run a cron loop?

Yes. `@BatchScheduled` itself only declares metadata; the configured
transport owns the real trigger-to-launch bridge.

With `InProcessAdapter`, `InProcessSchedule` runs a cron loop in the
same server process and calls `JobLauncher.launch(jobId, params)` on
each fire. With BullMQ, `BullmqSchedule` installs a BullMQ
`upsertJobScheduler` for every non-inert entry and, when configured
with `autoStartWorker: true`, starts the schedule-queue worker that
consumes schedule fires and calls `JobLauncher.launch(jobId, params)`.

The in-process path is single-process only: if the same app runs on
multiple replicas, every replica has its own timer unless the host adds
a leader election or distributed lock.

Set `BATCH_SCHEDULED_DISABLE=1` to put cron-scheduled jobs into
inert mode for tests.

### Is there a Drizzle adapter?

Yes, [`@nest-batch/drizzle`](../../packages/drizzle/README.md)
`0.2.0`. It is a driver-agnostic adapter slot; pair it with
[`@nest-batch/postgresql`](../../packages/postgresql/README.md) for
Postgres support or with
[`@nest-batch/mysql`](../../packages/mysql/README.md) for MySQL
support. The package's `DrizzleJobRepository` and
`DrizzleTransactionManager` satisfy the
[`@nest-batch/core/test-contracts`](../core/README.md#contract-suite).

### Is there a Kafka transport?

Yes, [`@nest-batch/kafka`](../../packages/kafka/README.md) `0.2.0`.
It is partition-aware (see
[`docs/RELEASE-0.2.0.md`](../RELEASE-0.2.0.md) §6). Its
`KafkaSchedule` ships a hand-rolled `*/N * * * *` parser;
richer Quartz / Spring Batch cron syntax is on the 0.3.0 roadmap.

### Is there a Prisma adapter?

Yes, [`@nest-batch/prisma`](../../packages/prisma/README.md)
`0.2.0`. It is a driver-agnostic adapter slot; pair it with
[`@nest-batch/postgresql`](../../packages/postgresql/README.md) for
Postgres support or with
[`@nest-batch/mysql`](../../packages/mysql/README.md) for MySQL
support. The package's `PrismaJobRepository` and
`PrismaTransactionManager` satisfy the
[`@nest-batch/core/test-contracts`](../core/README.md#contract-suite).

### Is there a MySQL adapter?

Yes, [`@nest-batch/mysql`](../../packages/mysql/README.md) `0.2.0`
(sibling package; no MySQL provider in the 8 other packages).
It owns the 4 MySQL adapter shells (`MikroOrmMySql`, `TypeOrmMySql`,
`DrizzleMySql`, `PrismaMySql`) and a 6-table MySQL migration. The
MySQL boundary test (T-AC-2 in
[`packages/core/tests/core/boundary/no-mysql-in-existing-packages.test.ts`](../../packages/core/tests/core/boundary/no-mysql-in-existing-packages.test.ts))
confirms no MySQL provider leaks into the 8 non-MySQL packages.

### Is there a webhook delivery?

Yes, [`@nest-batch/webhook`](../../packages/webhook/README.md)
`0.2.0` with HMAC-SHA256 signing
(`X-Nest-Batch-Signature: t=<unix>,v1=<hex>`), exponential backoff
at fixed 1s / 5s / 25s / 125s delays, 4xx-no-retry / 5xx-retry,
and a `logger.warn` dead-letter after the final failed attempt. See
[`docs/RELEASE-0.2.0.md`](../RELEASE-0.2.0.md) §7 for the full
contract.

### Can I run `@BatchScheduled` against a non-UTC timezone?

Yes. The `timezone` option in `BatchScheduledOptions` is required
and must be a valid IANA zone identifier (e.g. `'UTC'`,
`'Asia/Seoul'`, `'America/New_York'`). The decorator validates the
timezone using the platform's `Intl.DateTimeFormat` and throws
`InvalidBatchScheduledTimezoneError` for unknown / empty / whitespace
values. The runtime scheduler is the layer that converts the cron
expression to the local timezone; the decorator just captures
both verbatim.

---

## Misc

### Where can I see the package family in action?

`apps/demo` in this repo wires the full family
(`@nest-batch/core` + `@nest-batch/mikro-orm` +
`@nest-batch/bullmq`) into a runnable Nest app with a
`POST /jobs/import-products` endpoint. The demo supports both
`BATCH_TRANSPORT=in-process` and `BATCH_TRANSPORT=bullmq`; flip the
env var to compare. See
[`docs/QUICKSTART.md`](./QUICKSTART.md#5-run-the-demo-app) for the
run command and
[`README.md`](../README.md) for the consumer-side wiring snippet.

### Is there an admin UI / dashboard?

No. There is no admin UI, no job management dashboard, and no REST
endpoint for inspecting / re-launching / cancelling jobs beyond
what you build yourself. The `JobRepository` interface gives you
the primitives (`status`, last execution, latest step execution) —
build your own UI on top.

### Is there a metrics / tracing / webhook integration?

No. There is no Prometheus exporter, no OpenTelemetry tracing, no
StatsD integration, no webhook delivery. The `BatchObserver`
contract lets you ship events to your own backend; that is the
documented extension point. Anything more is out of scope.
