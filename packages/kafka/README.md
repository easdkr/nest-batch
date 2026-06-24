# `@nest-batch/kafka`

Kafka transport strategy for [`@nest-batch/core`](../core). Provides
a NestJS dynamic module that overrides the core `EXECUTION_STRATEGY`
token with a Kafka-backed `IExecutionStrategy`, so a host app can
switch the `JobLauncher`'s execution target from in-process to a
Kafka-backed queue with a single line of DI wiring.

> **Kafka is the transport runtime, not the batch engine.** This
> package owns the KafkaJS `Producer` / `Consumer` lifecycle, the
> topic + consumer-group plumbing, the dead-letter path, and the
> `*/N * * * *` cron firing for `@BatchScheduled`. The batch
> engine itself (Job/Step/Chunk/Tasklet semantics, checkpoint,
> restart, skip, chunk transaction, business retry) lives in
> [`@nest-batch/core`](../core). Kafka is the courier; the
> `JobExecutor` is the worker.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/kafka  ──▶  @nest-batch/core
        │
        └──────────────▶  kafkajs (peer)
```

`@nest-batch/core` does **not** know that this package exists, and
must never import `kafkajs` (or any queue runtime) into its own
`src/`. The boundary is enforced by
[`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`](../core/tests/core/boundary/no-forbidden-imports.test.ts),
which scans the core source tree and fails the build if any
forbidden package — `kafkajs`, `bullmq`, `mikro-orm`, `typeorm`,
`drizzle-orm`, `cron` — appears as an import.

Consequence: adding `kafkajs` to this package's `devDependencies`
(and listing it as a peer dep) is the only way for the host to
get a Kafka transport. The core module stays dependency-light.

---

## Install

```bash
pnpm add @nest-batch/kafka
```

Peer dependencies the host must already provide:

| Package            | Range          |
| ------------------ | -------------- |
| `@nest-batch/core` | `workspace:*`  |
| `@nestjs/common`   | `^10 \|\| ^11` |
| `@nestjs/core`     | `^10 \|\| ^11` |
| `kafkajs`          | `^2.2.4`       |

`kafkajs` is hard-pinned to `^2.2.4` — the first KafkaJS line with
the `baseOffset` field on producer results that the runtime
service reads when the broker acks a send. The version range is
the contract the test suite relies on; widening or narrowing it
breaks the `KafkaRuntime.launch()` offset-resolution path.

The adapter is otherwise peer-dep-light: it does not need a
specific broker version, SSL/TLS library, or schema registry. TLS
is forwarded as-is to KafkaJS via the `connection.ssl` field; SASL
is forwarded as-is via `connection.sasl`.

---

## Wiring

The adapter ships two factories — `forRoot()` (synchronous) and
`forRootAsync()` (async, for config-service-sourced connections) —
that both return a `BatchAdapter` carrier for the
`NestBatchModule.forRoot({ adapters: { transport, ... } })` API.

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { KafkaAdapter } from '@nest-batch/kafka';

@Module({
  imports: [
    NestBatchModule.forRoot({
      adapters: {
        transport: KafkaAdapter.forRoot({
          connection: {
            brokers: [process.env.KAFKA_BROKER ?? '127.0.0.1:9092'],
            clientId: 'nest-batch-app',
            // ssl, sasl, connectionTimeout, requestTimeout also accepted
          },
          autoStartConsumer: true, // starts a Consumer on bootstrap
          topic: 'nest-batch-work',
          consumerGroupId: 'nest-batch-consumer',
        }),
      },
    }),
  ],
})
export class AppModule {}
```

`KafkaAdapter.forRoot({ connection, ... })` is the only required
field beyond the host's own `NestBatchModule.forRoot()` call. The
connection options are the shared host / port / SSL / SASL record.
The runtime service derives the per-role client (producer vs
consumer) tuning internally.

`autoStartConsumer` defaults to `false`. Set it to `true` to
start a KafkaJS `Consumer` on `OnApplicationBootstrap`. A
launcher-only deployment (e.g. an API service that only enqueues)
should leave it `false` so the deployment does not accidentally
consume Kafka.

Async configuration (e.g. when the connection comes from a config
service):

```ts
KafkaAdapter.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    connection: {
      brokers: cfg.get<string[]>('kafka.brokers'),
      clientId: cfg.get<string>('kafka.clientId'),
    },
  }),
});
```

The Kafka adapter's `DynamicModule` is registered as
`global: true` (matching `NestBatchModule`) so consumers do not
need to re-import it in every sub-module.

> **Cron-parser limitation — read this before configuring
> `@BatchScheduled` against Kafka.** The hand-rolled
> `*/N * * * *` parser in
> [`packages/kafka/src/kafka-schedule.ts:228-250`](./src/kafka-schedule.ts)
> is a **known 0.2.0 limitation**. Only the 5-field cron shape
> `*/N * * * *` (a fixed minute interval, every other field
> wildcard) is supported. Richer expressions — Quartz 6-field
> syntax, named months / weekdays, `1,15,30 * * * *` lists,
> `0 9-17 * * 1-5` ranges, Spring Batch's 6-field variant — are
> **not** recognized. The parser returns `null` for them and the
> schedule does not fire. The full Spring Batch cron shape ships
> in 0.3.0. If you need the full syntax today, run the cron
> against `@nest-batch/bullmq` (which uses BullMQ's
> `upsertJobScheduler` and supports the full cron grammar) and
> keep Kafka for the per-step message transport.

---

## Contract test

The adapter ships with an end-to-end test that exercises the full
produce → consume → DB-execution loop against a real Kafka broker.
The test is gated by the `RUN_KAFKA_E2E` environment variable so
`pnpm test` stays green in CI environments without a Kafka
service.

```bash
# Gate the test on (default: skip). Bring up Kafka first:
docker compose up -d kafka     # or use any Kafka broker on :9092

# Run the e2e suite for the kafka package
RUN_KAFKA_E2E=1 pnpm --filter @nest-batch/kafka test -- tests/e2e.test.ts
```

The e2e test starts a single-tasklet job, asserts the Kafka
`Producer.send()` returns a non-empty offset, the consumer picks
the message up, the DB `JobExecution` row transitions to
`COMPLETED`, and the module close path is idempotent. The test
also re-executes the `@nest-batch/core` shared contract suite's
DB-first invariant against the Kafka runtime bridge (the
canonical execution state lives in the `JobRepository`; the Kafka
message is a correlation stamp, not a state row).

The unit-level runtime bridge test (`tests/kafka-runtime.test.ts`)
runs without `RUN_KAFKA_E2E=1` and covers the unreachable-broker
failure path (producer must throw within 5s, never hang) and the
business-skip-doesn't-consume-Kafka-retries invariant.

---

## What is NOT in this package

- A persistence adapter. Use `@nest-batch/mikro-orm`,
  `@nest-batch/typeorm`, `@nest-batch/drizzle`, or
  `@nest-batch/prisma` to wire a `JobRepository`. The transport
  reads and writes the same `JobExecution` rows.
- A batch engine. Step / chunk / tasklet semantics, skip, restart,
  checkpoint, and business retry live in
  [`@nest-batch/core`](../core). Kafka is the courier.
- Rich cron syntax. The hand-rolled `*/N * * * *` parser is the
  0.2.0 contract; Quartz / Spring Batch 6-field cron ships in
  0.3.0 (see the callout above).
- A partition refactor for chunked steps. The 0.2.0 Kafka strategy
  enqueues one Kafka message per step (the per-step granularity
  the BullMQ transport mirrors). The partition fan-out work
  (`ChunkStepDefinition.partitions.count > 1`) lands in 0.3.0
  across both transports.
- An admin UI, metrics backend, tracing backend, or webhook system.
  Hook a `BatchObserver` to ship events where you need them.
- Alternative queue transports (Sidekiq, RabbitMQ, SQS, Celery).
  `@nest-batch/core`'s `IExecutionStrategy` polymorphism makes
  these possible, but they are not in scope for this release.

---

## Scripts

```bash
pnpm --filter @nest-batch/kafka build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/kafka test       # vitest run (unit; uses docker compose Kafka when available)
pnpm --filter @nest-batch/kafka test:watch # vitest watch
pnpm --filter @nest-batch/kafka typecheck  # tsc --noEmit
```

The integration tests expect a Kafka broker at
`127.0.0.1:9092` (the docker-compose default). The `RUN_KAFKA_E2E`
gate is honored by the e2e suite; unit tests skip gracefully when
the broker is unreachable so `pnpm test` stays green in CI
environments without Kafka. The boundary test in core
(`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`)
is the canary for "KafkaJS did not leak into core". Run it
locally with:

```bash
pnpm --filter @nest-batch/core test -- tests/core/boundary/no-forbidden-imports.test.ts
```
