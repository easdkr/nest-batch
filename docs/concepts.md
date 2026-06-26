# Concepts

`nest-batch` provides durable batch jobs, chunk processing, restart state, and
runtime adapters while staying native to NestJS dependency injection.

## Job

A job is a named unit of work. It is declared with `@Batch.Jobable` or the
builder APIs from `@nest-batch/core`.

```ts
@Batch.Jobable({ id: 'import-users', restartable: true })
export class ImportUsersJob {}
```

The job id is the public name used by `JobLauncher.launch(jobId, params)`.

## Step

A job is made of one or more steps. A step is either:

- a tasklet step: one async method that runs once
- a chunk step: read, process, and write items in chunks

## Tasklet Step

Use a tasklet when the unit of work is a single operation rather than
item-level chunking.

```ts
@Batch.Stepable({ id: 'prepare-report' })
@Batch.Tasklet()
async prepareReport() {
  await createReportSnapshot();
}
```

## Chunk Step

Use a chunk step when the job reads many items and writes them in batches.

```ts
@Batch.Stepable({ id: 'sync-users', chunkSize: 500 })
syncUsers(): void {}

@Batch.ItemReader()
read() {}

@Batch.ItemProcessor()
process(item: UserRow) {}

@Batch.ItemWriter()
write(items: User[]) {}
```

The chunk is the transaction boundary. If a write fails, the current chunk can
roll back without replaying completed chunks.

## Restart-Safe Readers

Chunk steps always persist `lastChunkIndex` in the step `ExecutionContext`.
Stateful readers can persist their own cursor in that same context by returning
an object that implements both `ItemReader` and `ItemStream`.

```ts
class CursorReader implements ItemReader<UserRow>, ItemStream {
  private cursor: string | null = null;

  async open(context: ExecutionContext) {
    const data =
      context.data && typeof context.data === 'object' && !Array.isArray(context.data)
        ? (context.data as { cursor?: string })
        : {};
    this.cursor = data?.cursor ?? null;
  }

  async read() {
    const row = await findNextUser({ after: this.cursor });
    this.cursor = row?.id ?? this.cursor;
    return row;
  }

  async update(context: ExecutionContext) {
    const data =
      context.data && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    return { ...context, data: { ...data, cursor: this.cursor } };
  }

  async close() {}
}

@Batch.ItemReader({ factory: true })
createReader(ctx?: ItemExecutionContext) {
  return new CursorReader(ctx?.jobParameters.tenantId);
}
```

On restart, the failed step's full `ExecutionContext` is copied to the new step
execution before `open()` runs. If the reader is an `ItemStream`, the executor
trusts that checkpoint and does not drain already-committed chunks. Plain method
readers keep the legacy `lastChunkIndex` skip behavior.

## Job Parameters

Parameters identify a job run request.

```ts
await launcher.launch('sync-users', {
  tenantId: 'acme',
  businessDate: '2026-06-25',
});
```

Use stable business keys in parameters so retries and restarts can find the
right durable execution state.

## Persistence

The database is where durable batch state lives. A persistence adapter binds
`JobRepository` and `TransactionManager` to your ORM or database client.

Migration ownership stays in your application. Add the metadata
entities/schema/model to your app and generate migrations in your normal
migration flow.

## Transport

The transport adapter decides where execution happens.

- `InProcessAdapter`: run inside the launcher process
- `BullmqAdapter`: enqueue to Redis/BullMQ
- `KafkaAdapter`: enqueue to Kafka
- AWS/Kubernetes adapters: start external worker tasks

Business chunk semantics stay in `@nest-batch/core`; transport adapters move
work between processes.

## Scheduling

`@BatchScheduled` records schedule metadata on a job method.

```ts
@BatchScheduled('0 * * * *', {
  name: 'hourly-import',
  timezone: 'UTC',
  overlap: 'skip',
})
scheduledImport(): void {}
```

Runtime adapters decide how schedules are fired. BullMQ and Kafka can bridge
schedule fires into launches; EventBridge Scheduler can mirror the schedule into
AWS.

## Observability

Use listeners and observers for instrumentation.

- Listener decorators run around job, step, chunk, read, process, write, and
  skip events.
- `@nest-batch/webhook` sends signed lifecycle event envelopes to external
  systems.
- `JobExplorer` and `JobOperator` provide inspection and control APIs for
  application endpoints or admin tools.
