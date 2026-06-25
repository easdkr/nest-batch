# FAQ

## Does `@nest-batch/core` include a database adapter?

No. Core owns job semantics and public contracts. Choose a persistence adapter
such as `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/drizzle`,
or `@nest-batch/prisma`.

## Does the package run migrations for me?

No. The consuming application owns migrations. Add the exported metadata
entities, schema, or models to your application and generate migrations with
your existing ORM tooling.

## Which transport should I start with?

Use `InProcessAdapter` first unless you already need a separate worker fleet.
Move to BullMQ, Kafka, SQS, ECS, AWS Batch, or Kubernetes when your deployment
needs queueing, isolation, or external compute.

## Why does `JobLauncher.launch` return before the job is complete?

Queued and external-task transports hand work to another runtime. In those
deployments, the launch response reflects durable state after enqueue or task
submission. Use `JobExplorer` or your own endpoint to read the final status.

## Can one Nest application define several jobs?

Yes. Register each `@Batch.Jobable` class as a provider. `NestBatchModule`
discovers all registered job providers at bootstrap.

## Can I schedule jobs?

Yes. Add `@BatchScheduled` to a marker method on a job class. Use a runtime
adapter that bridges schedules to launches, or use
`@nest-batch/aws-eventbridge-scheduler` to create AWS Scheduler entries.

## Does BullMQ process each item as a BullMQ job?

No. BullMQ is the transport for batch work. Chunk reading, processing, writing,
skip, retry, and checkpoint behavior remain in core.

## Can I receive lifecycle events?

Yes. Use listener decorators in your job class for local hooks, or add
`@nest-batch/webhook` to send signed lifecycle event envelopes to external
systems.

## Is there an admin UI?

`@nest-batch/admin` provides a small Nest controller and HTML renderer under
`/batch`. It is intended as a lightweight operational surface that you can wrap
with your application authentication and authorization.
