# Adapters

Database and queue choices stay in your application. A working module
configuration selects one persistence adapter and one transport adapter.

The two adapter slots answer different questions:

| Slot          | Question it answers                   | Runtime responsibility                                                                                            |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `persistence` | Where is durable batch state stored?  | Implements `JobRepository` and `TransactionManager` for job instances, executions, step executions, and contexts. |
| `transport`   | Where does execution actually happen? | Runs the job in-process, enqueues it to a worker runtime, or starts an external compute task.                     |

They are independent choices. You can keep the same persistence adapter and
move from local execution to BullMQ, Kafka, SQS, ECS, AWS Batch, or Kubernetes
without changing job definitions.

```ts
NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

## Persistence Adapters

| Adapter  | Package                 | What it owns                                                                      | Host still owns                                                                |
| -------- | ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MikroORM | `@nest-batch/mikro-orm` | MikroORM-backed `JobRepository`, `TransactionManager`, and `BATCH_META_ENTITIES`. | `MikroOrmModule.forRoot`, database connection, and migrations.                 |
| TypeORM  | `@nest-batch/typeorm`   | TypeORM-backed repository/transaction manager and batch meta entities.            | `TypeOrmModule.forRoot`, `DataSource`, database connection, and migrations.    |
| Drizzle  | `@nest-batch/drizzle`   | Drizzle repository/transaction manager contract.                                  | `drizzle()` setup, connection pool, schema composition, and migrations.        |
| Prisma   | `@nest-batch/prisma`    | Prisma repository/transaction manager contract against a generated client.        | `schema.prisma`, Prisma Client generation, database connection, and migration. |

Persistence adapters bind the core `JOB_REPOSITORY_TOKEN` and
`TRANSACTION_MANAGER_TOKEN`. Your application keeps ownership of its database
connection and migration flow.

## Database Driver Packages

`@nest-batch/postgresql` and `@nest-batch/mysql` provide DB-specific shells for
the ORM slots.

```ts
import { PostgresDrizzleAdapter, postgresDrizzleSchema } from '@nest-batch/postgresql';
import { MysqlDrizzleAdapter, mysqlDrizzleSchema } from '@nest-batch/mysql';
```

Use these packages when the selected ORM adapter needs a driver-specific table
shape or runtime binding.

## Transport Adapters

| Adapter     | Package                  | What happens on launch                                                                 |
| ----------- | ------------------------ | -------------------------------------------------------------------------------------- |
| In-process  | `@nest-batch/core`       | The current Nest process executes the job immediately.                                 |
| BullMQ      | `@nest-batch/bullmq`     | The launcher enqueues work in Redis; BullMQ workers consume and run the batch runtime. |
| Kafka       | `@nest-batch/kafka`      | The launcher produces a Kafka message; consumers run the batch runtime.                |
| SQS         | `@nest-batch/aws-sqs`    | The launcher sends an SQS message; your worker runtime receives and executes it.       |
| ECS Fargate | `@nest-batch/aws-ecs`    | The launcher starts an ECS Fargate task with job execution arguments.                  |
| AWS Batch   | `@nest-batch/aws-batch`  | The launcher submits an AWS Batch job with job execution arguments.                    |
| Kubernetes  | `@nest-batch/kubernetes` | The launcher creates a Kubernetes Job manifest for the job execution.                  |

Transport adapters bind the core execution strategy. Job definitions stay in
core, and durable state stays behind the selected persistence adapter.

## Scheduler and Observer Packages

`@nest-batch/aws-eventbridge-scheduler` reads discovered `@BatchScheduled`
entries and creates AWS EventBridge Scheduler resources.

`@nest-batch/webhook` subscribes to batch lifecycle events and sends signed JSON
payloads to configured URLs.

These packages are optional companions. They are added alongside the main
`NestBatchModule` wiring.

## Admin and Deployment Helpers

`@nest-batch/admin` provides a small HTTP controller and HTML renderer for job
inspection and operations.

`@nest-batch/deployment` exports typed recipe helpers for documenting or
generating runtime infrastructure plans.
