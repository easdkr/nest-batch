# `@nest-batch/core`

A lightweight, NestJS-coupled batch processing core modelled after Spring
Batch. `@nest-batch/core` owns the **batch engine**: Job/Step/Chunk/Tasklet
semantics, checkpoint, restart, skip, chunk transaction, and business retry.
It does not own persistence, transport, or scheduling. Those live in
[sibling packages](#what-is-not-in-core).

The package is dependency-light on purpose. It only pulls in
`@nestjs/common`, `@nestjs/core`, and `reflect-metadata`. Anything
specific to a database, a queue, or a scheduler is injected through
tokens at the DI boundary, so a host app can swap persistence and
transport without touching the core.

---

## Install

```bash
pnpm add @nest-batch/core
```

Peer dependencies are pulled in by the host app:

| Package            | Range     |
| ------------------ | --------- |
| `@nestjs/common`   | `^11.0.0` |
| `@nestjs/core`     | `^11.0.0` |
| `reflect-metadata` | `^0.2.2`  |

Core supports Nest 10 and 11.

---

## Conceptual model

The model is a direct port of Spring Batch's mental model. If you've
written a Spring Batch job, you already know 80% of this.

```
Job
└── Step (one or more)
    ├── Chunk step  (read → process → write in fixed-size chunks)
    │   ├── ItemReader<T>
    │   ├── ItemProcessor<T, R>
    │   └── ItemWriter<R>
    └── Tasklet       (single-method work unit, no chunking)
```

### Job

A named unit of work. The host app declares one with the `@Jobable`
decorator or the `BatchBuilder` fluent API. A job has:

- a unique `id`
- an ordered list of `Step`s
- a `JobParameters` shape (the params that pin a `JobInstance`)

### Step

A step is either a **chunk step** or a **tasklet step**. The compiler
decides which one based on which handler method you provide. Each step
runs inside a `StepExecution` row in the batch meta schema, and the
`StepExecution.id` is the unit of restart/checkpoint.

### Chunk step

A chunk step reads `chunkSize` items, processes them, writes them, and
repeats until the reader is exhausted. The chunk is the unit of
transaction: if any item in the chunk fails, the whole chunk rolls
back. This is the model Spring Batch uses, and we keep it.

The reader, processor, and writer are plain Nest providers. You can
declare them with `@ItemReader`, `@ItemProcessor`, `@ItemWriter` (under
the `BatchDecorators` namespace) or with method references on the job
class itself. Three reference kinds are accepted:

- `BuilderLambda` — a function value captured by the builder.
- `Method` — a method on the job class.
- `ProviderToken` — a Nest DI token resolved at runtime.

### Tasklet step

A single method that runs to completion. Useful for one-off work that
doesn't fit the read/process/write shape (e.g. "run this SQL and
move on"). A tasklet is the right answer when you don't need chunking,
skip, or restart.

### Listeners

Listeners fire around every transition in the engine. You tag a method
on your provider with one of the listener decorators, and the engine
calls it at the right moment. The full set:

| Decorator         | Fires                                         |
| ----------------- | --------------------------------------------- |
| `@BeforeJob`      | Before a job execution starts.                |
| `@AfterJob`       | After a job execution finishes (any status).  |
| `@BeforeStep`     | Before a step execution starts.               |
| `@AfterStep`      | After a step execution finishes (any status). |
| `@BeforeChunk`    | Before each chunk (read-process-write cycle). |
| `@AfterChunk`     | After each chunk finishes successfully.       |
| `@OnChunkError`   | When a chunk throws.                          |
| `@BeforeRead`     | Before each item is read.                     |
| `@AfterRead`      | After each item is read.                      |
| `@OnReadError`    | When the reader throws.                       |
| `@BeforeProcess`  | Before each item is processed.                |
| `@AfterProcess`   | After each item is processed.                 |
| `@OnProcessError` | When the processor throws.                    |
| `@BeforeWrite`    | Before the writer receives a chunk.           |
| `@AfterWrite`     | After the writer finishes a chunk.            |
| `@OnWriteError`   | When the writer throws.                       |
| `@OnSkipRead`     | When a read is skipped by the skip policy.    |
| `@OnSkipProcess`  | When a processed item is skipped.             |
| `@OnSkipWrite`    | When a write is skipped.                      |

You can mark a listener as `nonCritical: true` via
`@BeforeJob({ nonCritical: true })` if the engine should swallow
exceptions from it. A critical listener that throws fails the
execution.

### Skip and retry policies

Skip and retry are Batch Core concerns, not transport concerns. The
default policy is "fail on first error", and you can swap in:

- `LimitSkipPolicy` — skip up to N items of a given kind
  (read/process/write), then fail.
- `ClassifySkipPolicy` — skip based on the exception class.
- `ExponentialBackoffRetryPolicy` — retry with exponential backoff.
- `FixedDelayRetryPolicy` — retry with a fixed delay.

The BullMQ package reuses these policies. It does **not** reimplement
them. See "what is NOT in core" below.

---

## Polymorphic `JobLauncher`

`JobLauncher` is the public entry point for starting a job. Its
signature is:

```ts
launch(jobId: string, params: JobParameters = {}): Promise<JobExecution>
```

The launcher does:

1. Look up the `JobDefinition` from the registry. Missing → `JobNotFoundError`.
2. Canonicalize `params` into a stable `jobKey` hash. Object key
   order, `null/undefined` omission, `Date → ISO` are all normalized
   so semantically-identical params yield the same key.
3. `createExecutionAtomic(jobId, jobKey, params)` — atomic
   get-or-create instance + `SELECT ... FOR UPDATE SKIP LOCKED` to
   serialize concurrent launches + running-execution check + insert.
4. Delegate to whatever `IExecutionStrategy` is bound to the
   `EXECUTION_STRATEGY` token. The default is the in-process strategy;
   `@nest-batch/bullmq` overrides it with a transport strategy.

`IExecutionStrategy` is the polymorphism seam:

```ts
export interface IExecutionStrategy {
  readonly name: string;
  launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult>;
}
```

`LaunchResult` is a discriminated union:

- `{ kind: 'completed', status }` — the strategy ran to a terminal
  state in-process. The launcher resolves the persisted
  `JobExecution` and returns it.
- `{ kind: 'enqueued', queueJobId }` — the strategy handed off to a
  transport. The launcher still resolves the latest persisted
  `JobExecution` (which is in `STARTING` / `STARTED` because the
  executor has not run yet on the launcher process).

The `JobLauncher.launch` API is intentionally stable. Strategies
change; the public surface does not.

---

## Module wiring

```ts
import { Module } from '@nestjs/common';
import {
  NestBatchModule,
  JobRepository,
  TransactionManager,
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
} from '@nest-batch/core';
import { MikroORMJobRepository, MikroORMTransactionManager } from '@nest-batch/mikro-orm';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import { ProductEntity } from './entities/product.entity';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      // ...
    }),
    NestBatchModule.forRoot(),
  ],
  providers: [
    { provide: JobRepository, useClass: MikroORMJobRepository },
    { provide: TransactionManager, useClass: MikroORMTransactionManager },
    InProcessExecutionStrategy,
    IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
  ],
})
export class AppModule {}
```

`NestBatchModule` is `global: true`, so sub-modules don't have to
import it again. The module exports `JobRegistry`, `DefinitionCompiler`,
`BatchExplorer`, `FlowEvaluator`, and `BatchScheduleRegistry` so
consumers can inject them from outside.

`forRootAsync` is also available when the repository/strategy bindings
need to come from a config service or another async source:

```ts
NestBatchModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    repository: {
      provide: JOB_REPOSITORY_TOKEN,
      useClass: cfg.get<Type<JobRepository>>('BATCH_REPOSITORY'),
    },
  }),
});
```

---

## Listener resolver

Listeners are discovered by walking every `@Jobable` class the
`BatchExplorer` finds, reading the `BATCH_LISTENER_METADATA` slot from
each method, and building a per-job, per-step resolver map. The map
is populated once at `OnApplicationBootstrap` (see
`BatchBootstrapper`) and is read on every transition.

Critical vs non-critical semantics:

- A **critical** listener that throws fails the execution. The
  executor records the failure and the listener exception is part of
  the failure context.
- A **non-critical** listener that throws is logged and contained. The
  execution continues.

The two paths are separated on purpose. Critical listener failures
should be loud, non-critical ones should not poison the run.

---

## Contract suite

`@nest-batch/core` ships a contract suite that the adapter packages
use to prove they implement the repository and transaction
contracts correctly. It is exposed at
`@nest-batch/core/test-contracts`:

```ts
import {
  runJobRepositoryContract,
  runTransactionManagerContract,
} from '@nest-batch/core/test-contracts';
```

The contract covers:

- `getOrCreateJobInstance` — idempotency, concurrent creation.
- `createExecutionAtomic` — atomicity, lock semantics, running-execution guard.
- `updateJobExecution` / `getJobExecution` — round-trip integrity.
- `createStepExecution` / `updateStepExecution` / `getStepExecution` — same for step rows.
- `getExecutionContext` / `saveExecutionContext` — versioning, optimistic concurrency.
- `findLatestStepExecution` — restart/checkpoint lookup; must return
  the most recent `StepExecution` for `(jobExecutionId, stepName)`.
- `TransactionManager` — wrap / commit / rollback / nested.

`@nest-batch/mikro-orm` and `@nest-batch/typeorm` both run this suite
against their implementations. The in-memory reference implementation
in core also passes it. If you write a custom adapter, the suite is
how you prove it satisfies the contract.

---

## Public API surface

Everything in `@nest-batch/core` is reachable from the package root.
The barrel re-exports:

- `./core` — IR (`JobDefinition`, `StepDefinition`, ...), errors, status, execution context, item interfaces, repository/transaction contracts.
- `./compiler` — turns discovered jobs into compiled IR.
- `./registry` — `JobRegistry` and friends.
- `./execution` — `JobLauncher`, `JobExecutor`, `InProcessExecutionStrategy`, `IExecutionStrategy`, `EXECUTION_STRATEGY`, `ChunkStepExecutor`, `TaskletStepExecutor`, `ListenerInvoker`, `RefResolver`.
- `./transaction` — `TransactionManager` token and contract.
- `./repository` — `JobRepository` token, contract, in-memory reference, ID generators.
- `./decorators` — under the `BatchDecorators` namespace (`@Jobable`, `@ItemReader`, `@ItemProcessor`, `@ItemWriter`, `@Tasklet`, listener decorators).
- `./scheduling/batch-scheduled` — `@BatchScheduled` and its schedule option/error types are also re-exported directly from the package root.
- `./module` — `NestBatchModule`, tokens, options.
- `./builder` — fluent `BatchBuilder`, `JobBuilder`, `StepBuilder`, `FlowBuilder`.
- `./explorer` — `BatchExplorer` (the metadata scanner).
- `./listeners` — built-in `LoggingListener`, `MetricsListener`, `TimingListener` reference implementations.
- `./policies` — `LimitSkipPolicy`, `ClassifySkipPolicy`, retry policies, backoff helpers.
- `./flow` — `FlowEvaluator` for the `on` / `from` / `end` flow DSL.
- `./observability` — `BatchObserver` contract, `BATCH_EVENT` constants, `NoopBatchObserver` default.

Decorator names collide with interface names (e.g. `Tasklet` is both a
decorator and an interface). Decorators are re-exported under
`BatchDecorators`; interfaces are reachable as bare names from
`./core/item`. This is intentional.

---

## What is NOT in core

Core is the engine. The following live in sibling packages and are
injected at the DI boundary:

| Concern                       | Package                 | Why                                                               |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------- |
| **Persistence (MikroORM)**    | `@nest-batch/mikro-orm` | Exposes the batch meta entities; the host owns migrations.        |
| **Persistence (TypeORM 1.0)** | `@nest-batch/typeorm`   | Exposes the same table contract as TypeORM 1.0.0 entities.        |
| **Transport (BullMQ)**        | `@nest-batch/bullmq`    | The Redis-backed execution strategy. Owns Queue/Worker lifecycle. |
| **Drizzle**                   | _not in this release_   | Explicitly excluded and deferred. See `MIGRATION.md`.             |

Core itself does **not** ship:

- A default `JobRepository` (the choice of DB is the host's).
- A default `TransactionManager` (same).
- A default transport (in-process is the default; siblings override).
- An admin UI.
- A metrics backend (Prometheus, OpenTelemetry, ...).
- A tracing backend.
- A webhook or notification system.
- A job visualization dashboard.
- Multi-tenant routing.

These are out of scope by design. If you need one, write a
`BatchObserver` adapter that hooks into the event stream, or open an
issue if you think it belongs in core.

---

## Scripts

```bash
pnpm --filter @nest-batch/core build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/core test       # vitest run
pnpm --filter @nest-batch/core test:watch # vitest watch
pnpm --filter @nest-batch/core test:e2e   # vitest e2e (requires Postgres/Redis)
pnpm --filter @nest-batch/core typecheck  # tsc --noEmit
```

The boundary test (`tests/core/boundary/no-forbidden-imports.test.ts`)
guards core's dependency-light promise. It fails the build if any
forbidden integration package (`bullmq`, `mikro-orm`, `typeorm`,
`drizzle-orm`) shows up as a core import. The small `cron` dependency
is intentionally allowed for the built-in in-process scheduler bridge.
