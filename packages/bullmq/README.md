# `@nest-batch/bullmq`

BullMQ transport adapter for [`@nest-batch/core`](../core). Provides a
NestJS dynamic module that overrides the core `EXECUTION_STRATEGY` token
with a BullMQ-backed `IExecutionStrategy`, so a host app can switch the
`JobLauncher`'s execution target from in-process to a Redis-backed
queue with a single line of DI wiring.

> **BullMQ is the transport runtime, not the batch engine.** This
> package owns the Redis client lifecycle, the worker / queue /
> queue-events plumbing, and the technical retry / backoff / rate
> limit / worker distribution policies. The batch engine itself
> (Job/Step/Chunk/Tasklet semantics, checkpoint, restart, skip,
> chunk transaction, business retry) lives in
> [`@nest-batch/core`](../core). BullMQ is the courier; the
> `JobExecutor` is the worker.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/bullmq  ──▶  @nest-batch/core
        │
        └──────────────▶  bullmq, ioredis (peer)
```

`@nest-batch/core` does **not** know that this package exists, and
must never import `bullmq` (or any queue runtime) into its own
`src/`. The boundary is enforced by
[`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`](../core/tests/core/boundary/no-forbidden-imports.test.ts),
which scans the core source tree and fails the build if any
forbidden package — `bullmq`, `mikro-orm`, `typeorm`, `drizzle-orm`,
`cron` — appears as an import.

Consequence: adding `bullmq` to this package's `dependencies` is the
only way for the host to get a BullMQ transport. The core module
stays dependency-light.

---

## Install

```bash
pnpm add @nest-batch/bullmq
```

Peer dependencies the host must already provide:

| Package            | Range         |
| ------------------ | ------------- |
| `@nest-batch/core` | `workspace:*` |
| `@nestjs/common`   | `^11.0.0`     |
| `@nestjs/core`     | `^11.0.0`     |
| `bullmq`           | `^5.0.0`      |

`bullmq` is hard-pinned to 5.x. BullMQ 5 is the first version with
the unified producer / worker connection options this package
encodes. Versions before 5.x are not supported.

---

## Local Redis setup

The repo ships a `docker-compose.yml` at the workspace root with a
`redis` service alongside the existing `postgres`. Bring it up with:

```bash
docker compose up -d redis
# wait ~3s for the healthcheck, then:
docker compose exec -T redis redis-cli ping
# → PONG
```

The compose service is configured for the BullMQ transport
semantics:

| Setting       | Value                           | Why                                                                                           |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `image`       | `redis:7-alpine`                | BullMQ 5 requires Redis ≥ 6.2.                                                                |
| `command`     | `--appendonly yes`              | AOF persistence is on so a container restart does not silently drop in-flight queue state.    |
| `command`     | `--maxmemory-policy noeviction` | BullMQ writes to Lua keys / streams; we never want Redis to evict them under memory pressure. |
| `healthcheck` | `redis-cli ping` every 5s       | Surfaces a Redis-down condition to `docker compose ps` within the healthcheck window.         |
| `port`        | `6379:6379`                     | The BullMQ client default. Override in `BullMqConnectionOptions` if you remap.                |

If you want Redis + Postgres in one go, the full local dev stack is:

```bash
docker compose up -d
```

### Key prefix

By default every key the package writes is prefixed with
`nest-batch:` (BullMQ appends its own `bull:` after the prefix, so
the full key looks like `nest-batch:bull:<queue-name>:<job-id>`).
This makes it safe to share a single Redis instance with other
applications. Change it via `BullMqConnectionOptions.keyPrefix` if
you need a different namespace.

---

## Connection policy (worker vs producer)

BullMQ is opinionated about Redis client behavior. The two roles
**must** use different options — otherwise a Redis outage will look
like a successful enqueue, or a stalled worker will look like a
connection error. The package applies this split transparently
based on the role it is building.

### Workers (consumer side)

The package sets these on every `Worker` / `QueueEvents` client:

```ts
{
  host, port, password, username, db, tls, keyPrefix,
  maxRetriesPerRequest: null,    // mandatory
  enableReadyCheck: false,       // mandatory
}
```

- `maxRetriesPerRequest: null` — BullMQ's internal blocking commands
  (`BLPOP`, `BRPOPLPUSH`, `XREADGROUP`) must not retry per request.
  A stalled worker should surface as a stalled job, not a
  connection error.
- `enableReadyCheck: false` — paired with the above so the client
  does not give up on a Redis that is briefly not-READY (e.g. while
  loading AOF on restart).

### Producers (enqueue side)

The package sets these on the `Queue` (producer) client:

```ts
{
  host, port, password, username, db, tls, keyPrefix,
  enableOfflineQueue: false,     // mandatory
  maxRetriesPerRequest: 1,
}
```

- `enableOfflineQueue: false` — a Redis-down condition must
  **raise an error synchronously on the enqueue call**, not buffer
  the command and return success. `JobLauncher.launch` propagates
  the error to the caller so the `JobExecution` is marked `FAILED`
  and the HTTP/RPC/cron trigger sees a real failure.
- `maxRetriesPerRequest: 1` — keep the first `add` fast. BullMQ
  warns against `maxRetriesPerRequest: null` on the producer
  (producers do not use blocking commands), so we use `1` and let
  ioredis handle reconnects.

You should not need to override either of these. The defaults are
the contract the test suite relies on.

---

## Wiring

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { BullmqBatchModule } from '@nest-batch/bullmq';

@Module({
  imports: [
    NestBatchModule.forRoot({
      // repository, transactionManager, ...
    }),
    BullmqBatchModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        keyPrefix: 'nest-batch:',
        // password, username, db, tls also accepted
      },
      autoStartWorker: true, // starts a Worker on bootstrap
    }),
  ],
})
export class AppModule {}
```

`BullmqBatchModule.forRoot({ connection })` is the only required
field. The connection options are the shared host / port / auth /
prefix / tls record. The package derives the per-role client
options internally.

`autoStartWorker` defaults to `false`. Set it to `true` to start a
BullMQ `Worker` on `OnApplicationBootstrap`. A launcher-only
deployment (e.g. an API service that only enqueues) should leave it
`false` so the deployment does not accidentally consume Redis.

Async configuration (e.g. when the connection comes from a config
service):

```ts
BullmqBatchModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    connection: {
      host: cfg.get<string>('redis.host'),
      port: cfg.get<number>('redis.port'),
      password: cfg.get<string>('redis.password'),
    },
  }),
});
```

`BullmqBatchModule` is registered as `global: true` (matching
`NestBatchModule`) so consumers do not need to re-import it in
every sub-module.

---

## Step / partition granularity

The adapter enqueues **one BullMQ job per step** (or, in a future
enhancement, one job per partition for chunked steps). It does not
enqueue one job per row, per chunk, or per item. The contract is
enforced by the `BullmqRuntimeService.launch()` method, which
takes the step's `id` from the `JobDefinition` and uses it as the
BullMQ `name` discriminator. The chunk loop runs _inside_ the
single BullMQ job, in the worker.

Why this matters:

- A BullMQ job's per-job overhead (queue entry, stream event,
  retry bookkeeping) is several milliseconds. With 25 input rows
  the per-row model creates 25 entries; with the step model it
  creates 1.
- The unit of retry is the step. A failed item retries the whole
  step (which is the right granularity for batch work, since
  business retry is Batch Core's job — see below).
- The unit of BullMQ technical retry is the step too. A Redis
  hiccup retries the step; a transient database error retries the
  step; a business validation failure does not consume a BullMQ
  attempt.

Future enhancement: chunked steps with explicit partition
configuration will enqueue one job per partition (e.g. one job per
range of 1000 input rows). The worker payload already carries a
`partitionIndex` field for that case.

---

## Business retry vs technical retry

The split is deliberate and tested:

- **Business retry** lives in Batch Core. Skip policies
  (`LimitSkipPolicy`, `ClassifySkipPolicy`) and business retry
  policies (`ExponentialBackoffRetryPolicy`,
  `FixedDelayRetryPolicy`) are pure functions over the chunk loop
  in `ChunkStepExecutor`. They do not consume BullMQ attempts.
- **Technical retry** lives in BullMQ. Connection errors, Redis
  hiccups, and worker crashes are retried by BullMQ's
  `attempts` / `backoff` policy on the job. Default is
  `attempts: 3`, `backoff: { type: 'exponential', delay: 100, jitter: 0.5 }`.

A business-invalid row is skipped by the skip policy and never
causes a BullMQ retry. A Redis-down condition triggers a BullMQ
retry on the step job, but does not change the DB state. The two
paths are observably separate.

---

## Lifecycle and graceful shutdown

The package implements `OnApplicationBootstrap` to spin up the
`Queue` / `Worker` / `QueueEvents` clients and
`OnApplicationShutdown` to close them in the documented order:

1. **Worker first.** In-flight jobs get a chance to finish or be
   returned to the queue.
2. **QueueEvents next.** No new events can arrive once the worker
   is closed.
3. **Queue last.** The producer is closed after the events stream
   so any pending `add()` calls had a chance to land.

The close path is idempotent. A second call (e.g. from a test
harness plus a Nest shutdown) short-circuits to the first close's
promise rather than racing.

`QueueEvents` `completed` / `failed` / `stalled` events are bridged
to a `BatchObserver` (defaulting to `NoopBatchObserver`). Observer
errors are logged and contained so a slow / failing observer
cannot poison the BullMQ event stream.

---

## What is NOT in this package

- A persistence adapter. Use `@nest-batch/mikro-orm` or
  `@nest-batch/typeorm` to wire a `JobRepository`. The transport
  reads and writes the same `JobExecution` rows.
- A batch engine. Step / chunk / tasklet semantics, skip, restart,
  checkpoint, and business retry live in
  [`@nest-batch/core`](../core). BullMQ is the courier.
- A scheduler. Cron-style scheduling lives in
  `@nest-batch/core`'s `@BatchScheduled` decorator, which stamps
  metadata read by the `BatchScheduleRegistry`. A future package
  (or a follow-up release of this one) will translate that metadata
  into BullMQ `QueueScheduler` jobs.
- An admin UI, metrics backend, tracing backend, or webhook system.
  Hook a `BatchObserver` to ship events where you need them.
- Alternative queue transports (Sidekiq, RabbitMQ, SQS, ...).
  `@nest-batch/core`'s `IExecutionStrategy` polymorphism makes
  these possible, but they are not in scope for this release.

---

## Scripts

```bash
pnpm --filter @nest-batch/bullmq build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/bullmq test       # vitest run (requires Redis via docker compose)
pnpm --filter @nest-batch/bullmq test:watch # vitest watch
pnpm --filter @nest-batch/bullmq typecheck  # tsc --noEmit
```

The integration tests expect a Redis instance at
`127.0.0.1:6379`. The repo's `docker compose up -d redis` is the
recommended way to bring it up.

The boundary test in core
(`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`)
is the canary for "BullMQ did not leak into core". Run it locally
with:

```bash
pnpm --filter @nest-batch/core test -- tests/core/boundary/no-forbidden-imports.test.ts
```
