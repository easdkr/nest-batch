# `@nest-batch/bullmq`

BullMQ transport adapter for [`@nest-batch/core`](../core). Provides a
NestJS dynamic module that overrides the core `EXECUTION_STRATEGY` token
with a BullMQ-backed `IExecutionStrategy`, so a host app can switch the
`JobLauncher`'s execution target from in-process to a Redis-backed
queue with a single line of DI wiring.

> **Status — Task 17 skeleton.**
> This package currently ships a documented **stub** strategy. The
> `BullMqExecutionStrategy.launch()` method returns
> `{ kind: 'completed', status: 'COMPLETED' }` without actually
> enqueuing work. The real enqueue / worker / FlowProducer lifecycle
> lands in **Task 18** on top of this skeleton. See
> [`.omo/plans/nest-batch-architecture-enhancement.md`](../../.omo/plans/nest-batch-architecture-enhancement.md)
> for the full roadmap.

---

## Boundary contract

`@nest-batch/bullmq` is a **sibling** of `@nest-batch/core`, not a
replacement. The dependency direction is strict and one-way:

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

| Setting                 | Value          | Why                                                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `image`                 | `redis:7-alpine` | BullMQ 5 requires Redis ≥ 6.2.                                                                 |
| `command`               | `--appendonly yes` | AOF persistence is on so a container restart does not silently drop in-flight queue state.       |
| `command`               | `--maxmemory-policy noeviction` | BullMQ writes to Lua keys / streams; we never want Redis to evict them under memory pressure. |
| `healthcheck`           | `redis-cli ping` every 5s | Surfaces a Redis-down condition to `docker compose ps` within the healthcheck window.           |
| `port`                  | `6379:6379`    | The BullMQ client default. Override in `BullMqConnectionOptions` if you remap.                     |

### Key prefix

By default every key the package writes is prefixed with
`nest-batch:` (BullMQ appends its own `bull:` after the prefix, so
the full key looks like `nest-batch:bull:<queue-name>:<job-id>`).
This makes it safe to share a single Redis instance with other
applications — change it via `BullMqConnectionOptions.keyPrefix` if
you need a different namespace.

---

## Connection policy (worker vs producer)

BullMQ is opinionated about Redis client behavior. The two roles
**must** use different options — otherwise a Redis outage will look
like a successful enqueue, or a stalled worker will look like a
connection error. The rules below are the defaults Task 18 will
encode in this package; you should not need to override them.

### Workers (consumer side)

```ts
new Worker(queueName, processor, {
  connection: {
    host: '127.0.0.1',
    port: 6379,
    // The two options below are mandatory for BullMQ workers.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
});
```

- `maxRetriesPerRequest: null` — BullMQ's internal blocking commands
  (`BLPOP`, `BRPOPLPUSH`, `XREADGROUP`) must not retry per-request.
  A stalled worker should surface as a stalled job, not a
  connection error.
- `enableReadyCheck: false` — paired with the above so the client
  does not give up on a Redis that is briefly not-READY (e.g. while
  loading AOF on restart).

### Producers (enqueue side)

```ts
new Queue(queueName, {
  connection: {
    host: '127.0.0.1',
    port: 6379,
    // The option below is mandatory for BullMQ producers.
    enableOfflineQueue: false,
  },
});
```

- `enableOfflineQueue: false` — a Redis-down condition must
  **raise an error synchronously on the enqueue call**, not buffer
  the command and return success. `JobLauncher.launch` propagates
  the error to the caller so the `JobExecution` is marked `FAILED`
  and the HTTP/RPC/cron trigger sees a real failure.

The Task 18 implementation will apply the worker/producer split
transparently — you only need to declare the shared
`BullMqConnectionOptions` (host/port/auth/prefix/tls) in
`BullmqBatchModule.forRoot({ connection: ... })`.

---

## Usage

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { BullmqBatchModule } from '@nest-batch/bullmq';

@Module({
  imports: [
    NestBatchModule.forRoot({
      // repository, transactionManager, ... (T11+)
    }),
    BullmqBatchModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        keyPrefix: 'nest-batch:',
      },
      autoStartWorker: true, // T18: starts a Worker on bootstrap
    }),
  ],
})
export class AppModule {}
```

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

## Peer dependencies

| Package                | Range            | Why                                                                  |
| ---------------------- | ---------------- | -------------------------------------------------------------------- |
| `@nest-batch/core`     | `workspace:*`    | The `IExecutionStrategy` contract and `EXECUTION_STRATEGY` token.   |
| `@nestjs/common`       | `^11.0.0`        | `Injectable`, `Inject`, `Module`, `DynamicModule`, ...               |
| `@nestjs/core`         | `^11.0.0`        | Peer of `@nestjs/common`; declared for `pnpm` resolution symmetry.   |
| `bullmq`               | `^5.0.0`         | The transport runtime. Hard-pinned to 5.x — BullMQ 5 is the first version with the unified producer/worker connection options the package encodes. |

Do **not** add BullMQ to `@nest-batch/core`'s `dependencies` — the
boundary test will fail. Run the test locally with:

```bash
pnpm --filter @nest-batch/core test -- tests/core/boundary/no-forbidden-imports.test.ts
```

---

## Build & test

```bash
# Build the package (SWC transpile + tsc declarations)
pnpm --filter @nest-batch/bullmq build

# Run the package's own tests
pnpm --filter @nest-batch/bullmq test

# Type-check only
pnpm --filter @nest-batch/bullmq typecheck
```

---

## What is NOT in this package yet (Task 18 scope)

The skeleton intentionally does **not** ship:

- Real `Queue` / `Worker` / `QueueEvents` / `FlowProducer`
  construction and lifecycle (creation, registration, graceful
  shutdown on `OnApplicationShutdown`).
- Producer fail-fast on Redis-down (uses `enableOfflineQueue: false`
  as documented above; the dedicated test is Task 18).
- Per-step / per-partition job unit decisions (Task 18 picks
  step-level vs partition-level based on the chunked step config).
- The DB-first state bridge (canonical `JobExecution` rows in
  PostgreSQL; BullMQ job ids are correlation stamps, not state
  rows).
- Scheduler / cron integration through BullMQ's `QueueScheduler`.
- Health check / metrics / tracing providers.

See the plan for the full T17 / T18 split and acceptance criteria.
