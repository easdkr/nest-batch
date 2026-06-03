# Migration notes

This document covers the breaking changes between the previous
single-package `@nest-batch/nest-batch` layout and the current
`@nest-batch/*` package family. It is a moving target: the most
recent structure-changing release is the **breaking new
major-structure release** that introduced `@nest-batch/core`,
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, and
`@nest-batch/bullmq` as sibling packages.

If you were on the pre-rename layout, the changes you need to make
are below. If you are adopting the package family fresh, this
document still matters: it lists what is **not** in this release so
you can decide whether the family meets your needs.

---

## TL;DR

- The library was split into four sibling packages.
- `@nest-batch/core` is now a dependency-light engine with stable
  public API.
- `@nest-batch/mikro-orm` and `@nest-batch/typeorm` each own a copy
  of the six Spring Batch-compatible batch meta tables.
- `@nest-batch/bullmq` provides the BullMQ transport strategy.
- `@nest-batch/drizzle` is **not in this release** (deferred).
- No admin UI, metrics, tracing, webhooks, or job visualization are
  shipped or promised.

---

## Package split

The previous `@nest-batch/nest-batch` package became four:

| Old location                                 | New package             |
| -------------------------------------------- | ----------------------- |
| `@nest-batch/nest-batch` (engine)            | `@nest-batch/core`      |
| `@nest-batch/nest-batch` (MikroORM bindings) | `@nest-batch/mikro-orm` |
| `@nest-batch/nest-batch` (TypeORM bindings)  | `@nest-batch/typeorm`   |
| `@nest-batch/nest-batch` (BullMQ transport)  | `@nest-batch/bullmq`    |

### Steps to migrate

1. **Update `package.json`.** Replace `@nest-batch/nest-batch`
   with the packages you actually need. The minimum is
   `@nest-batch/core`. Add the persistence and transport packages
   on top.

   ```diff
   - "@nest-batch/nest-batch": "x.y.z"
   + "@nest-batch/core": "0.1.0",
   + "@nest-batch/mikro-orm": "0.1.0",
   + "@nest-batch/bullmq": "0.1.0"
   ```

2. **Move persistence bindings.** If you were using the built-in
   MikroORM repository, switch to the one in
   `@nest-batch/mikro-orm`:

   ```ts
   import { MikroORMJobRepository, MikroORMTransactionManager } from '@nest-batch/mikro-orm';

   providers: [
     { provide: JobRepository, useClass: MikroORMJobRepository },
     { provide: TransactionManager, useClass: MikroORMTransactionManager },
   ];
   ```

   The `@nest-batch/typeorm` equivalent looks the same with
   `TypeOrmJobRepository` / `TypeOrmTransactionManager`.

3. **Wire the BullMQ transport if you need it.** Adding
   `BullmqBatchModule.forRoot({ connection, autoStartWorker })` is
   the only change needed to switch the launcher from in-process
   to BullMQ. The `JobLauncher.launch()` API does not change.

4. **Spread batch meta entities into your ORM config.** Each
   adapter package exports a `BATCH_META_ENTITIES` (or
   `batchMetaEntities`) tuple. Spread it into your `entities` list
   and run the bundled migration.

5. **Update imports.** The re-export surface moved. Decorators
   live under the `BatchDecorators` namespace from the core
   package. Interfaces stay reachable as bare names from
   `core/item`.

### What did NOT change

- The Spring Batch-like Job/Step/Chunk/Tasklet/Reader/Processor/Writer
  conceptual model is unchanged.
- The `@Jobable` / `@ItemReader` / `@ItemProcessor` / `@ItemWriter`
  / `@Tasklet` decorator names are unchanged.
- The listener decorator names are unchanged.
- The `JobLauncher.launch(jobId, params)` API is unchanged.
- The public `IJobRepository` contract is unchanged.
- The chunk transaction, skip, restart, and checkpoint semantics
  are unchanged.

---

## Public API stabilization

The following parts of `@nest-batch/core` are **stable** in this
release. Breaking changes to them will only happen in a future
major version, with a deprecation period where the old shape is
preserved as an alias.

### Polymorphic `JobLauncher` strategy

```ts
export const EXECUTION_STRATEGY: symbol = Symbol.for('@nest-batch/core/EXECUTION_STRATEGY');

export interface IExecutionStrategy {
  readonly name: string;
  launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult>;
}

export type LaunchResult =
  | { readonly kind: 'completed'; readonly status: JobStatus }
  | { readonly kind: 'enqueued'; readonly queueJobId: string };
```

The symbol-based token, the strategy interface, the launch context
shape, and the discriminated launch result are all part of the
stable contract. Sibling packages are free to add new
`IExecutionStrategy` implementations (and the bullmq package does),
but the surface that consumers depend on will not change.

### Listener API

The listener decorators, the resolver map, the
`nonCritical: true` opt-in, and the per-kind / per-phase dispatch
table are stable. The set of listener kinds is the canonical list
in [`packages/core/README.md`](./packages/core/README.md). New
kinds will be additive (new decorator names, not changed names).

### Cron decorator API

```ts
export type BatchOverlapPolicy = 'skip' | 'queue' | 'parallel';

export interface BatchScheduledOptions {
  name: string;
  timezone: string;
  overlap?: BatchOverlapPolicy;
  startAt?: Date;
  endAt?: Date;
  inert?: boolean;
}

export function BatchScheduled(
  cronExpression: string,
  options: BatchScheduledOptions,
): MethodDecorator;
```

The `@BatchScheduled` decorator, the `BatchOverlapPolicy`, and the
`BatchScheduledOptions` shape are stable. The `inert` mode
(controlled by `BATCH_SCHEDULED_DISABLE=1` at decoration time) is
the documented test escape hatch and will not change.

### Module wiring

`NestBatchModule.forRoot()` / `forRootAsync()`, the
`JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` /
`EXECUTION_STRATEGY` / `BATCH_SCHEDULE_REGISTRY` /
`MODULE_OPTIONS_TOKEN` symbols, and the `extraProviders` /
`repository` / `transactionManager` / `executionStrategy` override
slots are stable. Adapters can extend the options bag through
`AdapterOptions`; core will preserve their fields.

---

## Peer dependency boundaries

Each adapter package declares its own peer dependencies. The peer
ranges are hard-pinned; you cannot install a host on the wrong
major and have it work.

| Package                 | Peer dependency         | Range     |
| ----------------------- | ----------------------- | --------- |
| `@nest-batch/core`      | `@nestjs/common`        | `^11.0.0` |
| `@nest-batch/core`      | `@nestjs/core`          | `^11.0.0` |
| `@nest-batch/core`      | `reflect-metadata`      | `^0.2.2`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/core`       | `^6.0.0`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/nestjs`     | `^6.0.0`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/postgresql` | `^6.0.0`  |
| `@nest-batch/typeorm`   | `typeorm`               | `^1.0.0`  |
| `@nest-batch/bullmq`    | `bullmq`                | `^5.0.0`  |

`@nest-batch/core` does **not** declare a peer dependency on
`bullmq`, `mikro-orm`, `typeorm`, `drizzle-orm`, or `cron`. The
core boundary test fails the build if a forbidden package shows
up as a core import.

TypeORM 0.3 is intentionally not supported. The `typeorm: ^1.0.0`
peer range in `@nest-batch/typeorm` will not be widened. If you
need 0.3 support, stay on the previous
`@nest-batch/nest-batch` package (pre-rename).

MikroORM 5 is not supported either. The
`@mikro-orm/*: ^6.0.0` peer range is locked.

---

## What is NOT in this release

These are out of scope. They are not "coming soon" features; they
are explicitly excluded from this release, and a future release
that adds them will do so as a separate package (or a
clearly-flagged extension), not by retrofitting core.

### `@nest-batch/drizzle`

There is no Drizzle adapter in this release. The package
`@nest-batch/drizzle` does not exist in the workspace and is not
shipped. If you want a Drizzle adapter, you have three options:

1. Wait for a follow-up release. (We have not committed to one.)
2. Implement a `JobRepository` and `TransactionManager` against
   Drizzle yourself, then run the
   [`@nest-batch/core/test-contracts`](./packages/core/README.md#contract-suite)
   against it.
3. Use `@nest-batch/mikro-orm` or `@nest-batch/typeorm` instead.

Drizzle is **deferred**, not refused. If you have a strong use
case, file an issue.

### Admin UI

There is no admin UI, no job management dashboard, and no REST
endpoint for inspecting / re-launching / cancelling jobs beyond
what you build yourself. The `JobRepository` interface gives you
the primitives (status, last execution, latest step execution) —
build your own UI on top.

### Metrics

There is no Prometheus exporter, no OpenTelemetry metrics, no
StatsD integration. The `BatchObserver` contract lets you ship
events to your own backend; that is the documented extension point.
Anything more is out of scope.

### Tracing

There is no OpenTelemetry tracing, no Jaeger / Zipkin integration,
no automatic span creation around steps or chunks. Same as metrics:
`BatchObserver` is the extension point.

### Webhook

There is no webhook delivery, no HTTP callback on job completion,
no notification fan-out. Build it on top of `BatchObserver` if you
need it.

### Job visualization

There is no built-in Gantt chart, no step timing visualization, no
in-browser job inspector. Hook a `BatchObserver` to ship
`BATCH_EVENT.*` events to your own visualization backend.

### Alternate transports

There is no Sidekiq, no RabbitMQ, no SQS, no Celery, no Kafka
transport in this release. The `IExecutionStrategy` polymorphism
in core makes these possible, but they are not in scope. The only
transport shipped is BullMQ. If you need another transport, write
your own `IExecutionStrategy` and bind it to `EXECUTION_STRATEGY`
the same way `@nest-batch/bullmq` does.

### Multi-tenant routing

There is no built-in tenant-aware queue routing, no per-tenant
worker pools, no tenant isolation. BullMQ uses a single queue
(`nest-batch:work`); partitioning is by step, not by tenant.

---

## Closing notes

- Versions across the initial `@nest-batch/*` release are
  **lockstep** (`0.1.0` for all four). Bumping one will bump the
  rest. This avoids the "core 0.1.0 with bullmq 0.3.0 is broken"
  trap and keeps the contract suite meaningful.
- The boundary test in core
  (`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`)
  is the canary for accidental cross-contamination between
  packages. If a future change adds `bullmq` to core, that test
  fails the build.
- Anything that was an "open question" at plan time and is still
  open is out of scope for this release. Open a follow-up plan.
