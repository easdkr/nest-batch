# Concepts

`nest-batch` follows the same high-level model as Spring Batch while staying
native to NestJS dependency injection.

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
