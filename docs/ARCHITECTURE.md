# Architecture

This document captures the design principles that govern the
`@nest-batch/*` package family. The principles are tested by the
suite shipped with the repo; if a future change violates one, a test
fails before the change lands. Read this before you add a new package
or refactor an existing one.

The four principles, in order of how often they get violated by well-
intentioned PRs:

1. **BullMQ is the transport runtime, not the batch engine.**
2. **The database is the canonical source of execution state.**
3. **Step / partition is the unit of work; row / chunk / item never is.**
4. **Business retry and technical retry are observably separate.**

---

## 1. BullMQ is the transport runtime, not the batch engine

`@nest-batch/core` owns the batch engine: Job / Step / Chunk /
Tasklet semantics, checkpoint, restart, skip, chunk transaction, and
business retry. `@nest-batch/bullmq` owns the Redis client lifecycle,
the Worker / Queue / QueueEvents plumbing, and the technical retry /
backoff / rate-limit / worker-distribution policies. The two never
bleed into each other.

The shape of the boundary is the `IExecutionStrategy` interface in
`@nest-batch/core`. `JobLauncher.launch(jobId, params)` does the
canonical work (look up the job, canonicalize params, atomic
`get-or-create` of the `JobInstance`, running-execution guard) and
then hands the rest off to whatever is bound to the
`EXECUTION_STRATEGY` token:

```ts
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

The default strategy is the in-process one; `@nest-batch/bullmq` is
one of the alternative strategies. A host app that wants a different
transport (Sidekiq, RabbitMQ, SQS, ...) writes its own
`IExecutionStrategy` and binds it to `EXECUTION_STRATEGY` the same
way the bullmq package does. The launcher code does not change.

### Why this matters

- A consumer can swap the execution target from in-process to
  BullMQ by adding one `imports` line. No controller code, no job
  code, no repository code changes.
- The boundary test in
  `packages/core/tests/core/boundary/no-forbidden-imports.test.ts`
  fails the build if any of `bullmq`, `mikro-orm`, `typeorm`,
  or `drizzle-orm` shows up as an import inside `@nest-batch/core`'s
  `src/`. The small `cron` package is allowed only for the built-in
  in-process scheduler bridge. The test is the canary — if it fails,
  the principle is being violated.
- `@nest-batch/bullmq` cannot decide chunking semantics, cannot
  invent a new skip policy, cannot reach into the reader / processor
  / writer contract. It only enqueues, runs, and bridges BullMQ
  events into `BatchObserver` notifications.

### Anti-patterns the principle rules out

- Calling BullMQ from inside a `@Tasklet` or a `@ItemWriter` to
  schedule follow-up work. That's a job graph; declare a second
  step instead.
- Letting BullMQ's `attempts` / `backoff` shape leak into the core
  retry policy classes. Retry lives in `packages/core/src/policies/`
  and is transport-agnostic.
- Importing `bullmq` from a `@Jobable` consumer. The transport is a
  runtime concern, not a job-graph concern.

---

## 2. The database is the canonical source of execution state

The `JobRepository` row in PostgreSQL is the source of truth for
`status`, `startTime`, `endTime`, `exitCode`, and `exitMessage`. A
BullMQ job is a correlation stamp, not a state row. If a BullMQ
worker crashes mid-run, the DB row stays in `STARTED` and the host's
recovery path picks it up. If Redis loses the queue (eviction,
AOF corruption, restart), the DB row is unaffected.

The invariants that make this work:

1. **Atomic launches are enforced by the row lock.** The
   `createExecutionAtomic` flow uses
   `INSERT ... ON CONFLICT DO NOTHING` +
   `SELECT ... FOR UPDATE SKIP LOCKED` inside a single transaction
   to serialize concurrent launches. Two callers racing to launch
   the same `jobName + jobKey` get one winner; the loser sees a
   thrown `JobExecutionAlreadyRunningError`. The unique-index path
   was tried and retired — see migration `005-drop-active-execution-unique-index`
   for the write-contention reason.
2. **Restart and checkpoint go through the DB.** `findLatestStepExecution`
   returns the most recent `StepExecution` for `(jobExecutionId, stepName)`
   regardless of status, so the executor loads the last-committed
   chunk index from `batch_step_execution_context` and resumes.
3. **The contract suite proves it.** `@nest-batch/core` exports a
   contract suite at `@nest-batch/core/test-contracts` that
   `@nest-batch/mikro-orm` and `@nest-batch/typeorm` both run. The
   in-memory reference implementation in core also passes. If a
   host writes a custom adapter, the suite is the proof.

### Why this matters

- A host can switch transports without losing execution state. Move
  from in-process to BullMQ, scale workers up or down, restart the
  process — the same DB row drives every state transition the host
  sees.
- Two adapters writing to the same DB are safe by construction. The
  lock pattern serializes them.
- An admin tool (or a future admin UI package) reads from the same
  row a launcher writes to. The shape is one table, one row per
  run, one canonical contract.

### Anti-patterns the principle rules out

- Reading execution status from BullMQ (`Queue.getJob(id).returnvalue`).
  The DB row is canonical. The BullMQ job's `returnvalue` /
  `failedReason` is a debugging breadcrumb, not a source of truth.
- A custom `JobRepository` that does not implement the contract
  suite. The contract is what makes the rest of the family safe.
- Persisting chunk-level state outside the `batch_*` tables. If the
  state is not in the meta-schema, a restart cannot find it.

---

## 3. Step / partition is the unit of work; row / chunk / item never is

The BullMQ adapter enqueues **one BullMQ job per step** (or, in a
future enhancement, one job per partition for chunked steps). It
does not enqueue one job per row, per chunk, or per item. The
contract is enforced by `BullmqRuntime.launch()`, which
takes the step's `id` from the `JobDefinition` and uses it as the
BullMQ `name` discriminator. The chunk loop runs **inside** the
single BullMQ job, in the worker.

```
# Anti-pattern — do not do this
for chunk in chunks:
  await bullQueue.add('import-products', { chunk })     # ❌
# One BullMQ job per chunk, 25 jobs for 25 input rows when
# chunkSize=1.

# Correct shape
for step in job.steps:
  await bullQueue.add(step.id, { jobExecutionId, step })  # ✅
# One BullMQ job per step, regardless of input row count.
```

### Why this matters

- A BullMQ job's per-job overhead (queue entry, stream event, retry
  bookkeeping) is several milliseconds. With 25 input rows the
  per-row model creates 25 entries; with the step model it creates
  1.
- The unit of restart is the step. A failed item retries the whole
  step (which is the right granularity for batch work, since
  business retry is Batch Core's job — see principle 4).
- The unit of BullMQ technical retry is the step too. A Redis hiccup
  retries the step; a transient database error retries the step; a
  business validation failure does **not** consume a BullMQ attempt.

### Partition contract (ships in 0.2.0)

Partitioned steps ship in 0.2.0.
`ChunkStepDefinition.partitions: { count, range? }` lets a chunked
step declare parallel partitions; the BullMQ and Kafka strategies
enqueue one job per partition. `partitionIndex` is enforced as
`0 <= partitionIndex < count` at runtime. See
[`docs/RELEASE-0.2.0.md`](./RELEASE-0.2.0.md) §6 for the full
contract.

### Anti-patterns the principle rules out

- Enqueueing per-row. Even at 1k input rows that's a 1k-entry queue.
- Letting a consumer's `@ItemWriter` call `bullQueue.add(...)` to
  fan out. The writer writes its chunk and returns; the next step
  (or the next partition) is the transport's job.
- Using `InProcessAdapter` with `partitions.count > 1`. The
  in-process strategy is intentionally single-threaded; partition
  fan-out is a transport feature. The strategy either throws or
  logs a warning, never silently single-partitions. Pinned in
  `packages/core/tests/core/contracts/in-process-rejects-partitions.test.ts`.

---

## 4. Business retry and technical retry are observably separate

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
paths are observably separate in the test suite
(`packages/bullmq/tests/...`).

### Why this matters

- Mixing the two creates a retry storm. A business-invalid SKU
  triggers a BullMQ retry that hits the same business-invalid row
  again, consuming a BullMQ attempt that should have been reserved
  for an actual Redis outage.
- Mixing the two hides the failure mode. A "this job failed" page
  that conflates a bad row with a bad Redis makes triage
  impossible.
- Operators need to know which knob to turn. "Increase BullMQ
  `attempts`" fixes transport instability. "Add a
  `ClassifySkipPolicy`" fixes a class of business errors. The
  principles keep the two adjustments pointed at the right place.

### Anti-patterns the principle rules out

- A `JobRepository` that retries on business errors. The repository
  is the durable store; the engine decides whether to retry.
- A BullMQ `attempts` setting that exceeds 1 to "absorb" business
  failures. That path is for technical instability only.
- A listener that catches a business exception and re-throws it
  inside a `Queue.add()` call to "restart" the step. Use
  `JobLauncher.launch(jobId, params)` with a fresh `jobKey`; the
  DB is the canonical place to record a re-run.

---

## How the principles show up in the test suite

- **Boundary test.** `packages/core/tests/core/boundary/no-forbidden-imports.test.ts`
  fails if `bullmq`, `mikro-orm`, `typeorm`, or `drizzle-orm`
  imports appear in core's `src/`. Principle 1.
- **Contract suite.** `@nest-batch/core/test-contracts` exports
  `runJobRepositoryContract` and `runTransactionManagerContract`.
  `@nest-batch/mikro-orm` and `@nest-batch/typeorm` both run it
  against their implementations. Principle 2.
- **BullMQ granularity tests.** `packages/bullmq/tests/...` asserts
  the `step.id` is the BullMQ `name`, that chunking happens inside
  the worker, and that business retry does not consume BullMQ
  attempts. Principles 3 and 4.

If a future change violates one of the four principles, one of those
tests fails first. That is the design.
