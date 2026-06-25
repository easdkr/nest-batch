# nest-batch

NestJS batch processing packages for jobs that need durable execution
state, restartable steps, chunk-oriented processing, and pluggable runtime
adapters.

English is the default npm documentation language. Korean docs are available in
[README.ko.md](./README.ko.md) and in the matching `*.ko.md` files under
[`docs/`](./docs).

## How the Packages Fit Together

`nest-batch` is split by runtime responsibility. A real application usually
chooses one package from each required layer:

| Layer                       | What it does                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                        | Discovers job classes, compiles steps, runs chunk/tasklet logic, and exposes `JobLauncher`, `JobExplorer`, `JobOperator`, decorators, and tokens. |
| Persistence adapter         | Stores durable batch metadata such as job instances, job executions, step executions, checkpoints, and execution context in your database.        |
| Transport adapter           | Decides where the execution runs: the current process, a queue worker, SQS handoff, ECS task, AWS Batch job, or Kubernetes Job.                   |
| Optional companion packages | Add scheduling, webhook notification, admin routes, or deployment recipe helpers.                                                                 |

Persistence and transport are deliberately separate. Your job may store state in
PostgreSQL through MikroORM while running locally with `InProcessAdapter`, or use
the same persistence adapter while handing execution to BullMQ workers.

## Choose an Installation Shape

For local development or a single-process worker:

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm
```

For a separate Redis-backed worker:

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm @nest-batch/bullmq bullmq ioredis
```

For a Drizzle + PostgreSQL application:

```bash
pnpm add @nest-batch/core @nest-batch/drizzle @nest-batch/postgresql drizzle-orm pg
```

## Package Map

| Layer             | Package                                 | What it owns                                                                                                       | Add it when                                                                                     |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Core              | `@nest-batch/core`                      | Job/step model, decorators, chunk/tasklet execution, flow, launcher, explorer, operator, and adapter tokens.       | Every app that defines or launches batch jobs.                                                  |
| Persistence       | `@nest-batch/mikro-orm`                 | MikroORM-backed `JobRepository`, `TransactionManager`, and `BATCH_META_ENTITIES`.                                  | Your app already uses MikroORM or wants MikroORM to store batch metadata.                       |
| Persistence       | `@nest-batch/typeorm`                   | TypeORM-backed repository/transaction manager and TypeORM batch meta entities.                                     | Your app uses TypeORM and wants TypeORM-owned migrations.                                       |
| Persistence slot  | `@nest-batch/drizzle`                   | Drizzle repository/transaction manager contract. Driver-specific schema comes from a DB package.                   | Your app uses Drizzle; pair it with `@nest-batch/postgresql` or `@nest-batch/mysql`.            |
| Persistence slot  | `@nest-batch/prisma`                    | Prisma repository/transaction manager contract against a host-owned generated Prisma Client.                       | Your app uses Prisma and owns the batch meta models in its `schema.prisma`.                     |
| DB driver         | `@nest-batch/postgresql`                | PostgreSQL shells and Drizzle schema exports for the ORM adapter slots.                                            | Your persistence adapter runs against PostgreSQL and needs PostgreSQL-specific bindings/schema. |
| DB driver         | `@nest-batch/mysql`                     | MySQL shells and Drizzle schema exports for the ORM adapter slots.                                                 | Your persistence adapter runs against MySQL and needs MySQL-specific bindings/schema.           |
| Transport         | `@nest-batch/bullmq`                    | BullMQ execution strategy, Redis queue/worker runtime, and schedule bridge.                                        | Launcher and worker processes communicate through Redis/BullMQ.                                 |
| Transport         | `@nest-batch/kafka`                     | Kafka execution strategy, producer/consumer runtime, topic, and consumer-group wiring.                             | Launcher and worker processes communicate through Kafka.                                        |
| Transport         | `@nest-batch/aws-sqs`                   | SQS execution strategy that sends a batch work message to a queue.                                                 | The launcher should hand work to SQS and another runtime polls the queue.                       |
| External compute  | `@nest-batch/aws-ecs`                   | Execution strategy that starts an ECS Fargate task for a job execution.                                            | Each execution should run as a one-off ECS task.                                                |
| External compute  | `@nest-batch/aws-batch`                 | Execution strategy that submits an AWS Batch job.                                                                  | AWS Batch owns worker scheduling and compute allocation.                                        |
| External compute  | `@nest-batch/kubernetes`                | Execution strategy that creates a Kubernetes Job manifest.                                                         | Each execution should run as a Kubernetes Job.                                                  |
| Scheduler         | `@nest-batch/aws-eventbridge-scheduler` | Reads discovered `@BatchScheduled` metadata and creates EventBridge Scheduler schedules.                           | AWS should own schedule firing for your batch jobs.                                             |
| Notification      | `@nest-batch/webhook`                   | Batch event observer that signs and POSTs lifecycle event envelopes.                                               | External systems need job/step completion or failure notifications.                             |
| Admin             | `@nest-batch/admin`                     | Small Nest controller and HTML renderer backed by `JobExplorer` and `JobOperator`.                                 | You want basic `/batch` routes for inspection and operations.                                   |
| Deployment helper | `@nest-batch/deployment`                | Plain typed recipe objects for ECS, Kubernetes, AWS Batch, and SQS/EventBridge infrastructure planning/generation. | You want typed deployment metadata for docs, generators, or internal platform tooling.          |

## Minimal App Wiring

The batch module needs two explicit adapter choices:

- `persistence`: where durable execution state is stored
- `transport`: where execution is performed or handed off

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES, MikroOrmAdapter } from '@nest-batch/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [...BATCH_META_ENTITIES],
      driver: PostgreSqlDriver,
      dbName: process.env.DB_NAME,
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MikroOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

For a queued deployment, keep the same persistence adapter and replace the
transport:

```ts
import { BullmqAdapter } from '@nest-batch/bullmq';

NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: BullmqAdapter.forRoot({
      connection: { host: process.env.REDIS_HOST, port: 6379 },
      autoStartWorker: process.env.BATCH_WORKER === '1',
    }),
  },
});
```

## First Job

Decorators live under the `Batch` namespace from `@nest-batch/core`.

```ts
import { Injectable } from '@nestjs/common';
import { Batch, type ItemExecutionContext } from '@nest-batch/core';

interface InputRow {
  id: string;
  email: string;
}

@Injectable()
@Batch.Jobable({ id: 'import-users', restartable: true })
export class ImportUsersJob {
  private rows: InputRow[] = [
    { id: '1', email: 'a@example.com' },
    { id: '2', email: 'b@example.com' },
  ];

  @Batch.Stepable({ id: 'load-users', chunkSize: 100 })
  loadUsers(): void {
    // Marker method. The reader, processor, and writer below define the chunk step.
  }

  @Batch.ItemReader()
  async read(_ctx?: ItemExecutionContext): Promise<InputRow | null> {
    return this.rows.shift() ?? null;
  }

  @Batch.ItemProcessor()
  async process(row: InputRow): Promise<InputRow> {
    return { ...row, email: row.email.toLowerCase() };
  }

  @Batch.ItemWriter()
  async write(items: InputRow[]): Promise<void> {
    await saveUsers(items);
  }
}
```

Register the job class as a Nest provider. At application bootstrap,
`NestBatchModule` discovers `@Batch.Jobable` providers and registers their
compiled job definitions.

## Launching Jobs

Inject `JobLauncher` where your application wants to start work.

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { JobLauncher, type JobParameters } from '@nest-batch/core';

@Controller('jobs')
export class JobsController {
  constructor(private readonly launcher: JobLauncher) {}

  @Post('import-users')
  launch(@Body() params: JobParameters) {
    return this.launcher.launch('import-users', params);
  }
}
```

With `InProcessAdapter`, the launch call executes in the current process. With
queue or external-task adapters, the launch call records durable execution state
and hands work to the selected runtime.

## Choosing Adapters

| Need                         | Recommended packages                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| Simple local execution       | `@nest-batch/core` with `InProcessAdapter`                                  |
| Nest app using MikroORM      | `@nest-batch/core`, `@nest-batch/mikro-orm`                                 |
| Nest app using TypeORM       | `@nest-batch/core`, `@nest-batch/typeorm`                                   |
| Drizzle + PostgreSQL         | `@nest-batch/core`, `@nest-batch/drizzle`, `@nest-batch/postgresql`         |
| Prisma + MySQL               | `@nest-batch/core`, `@nest-batch/prisma`, `@nest-batch/mysql`               |
| Redis-backed workers         | `@nest-batch/bullmq`                                                        |
| Kafka-backed workers         | `@nest-batch/kafka`                                                         |
| AWS SQS handoff              | `@nest-batch/aws-sqs`                                                       |
| One-off compute tasks        | `@nest-batch/aws-ecs`, `@nest-batch/aws-batch`, or `@nest-batch/kubernetes` |
| External schedule management | `@nest-batch/aws-eventbridge-scheduler`                                     |
| Lifecycle notifications      | `@nest-batch/webhook`                                                       |
| Basic admin HTTP endpoints   | `@nest-batch/admin`                                                         |

## Documentation

- [Getting started](./docs/getting-started.md)
- [Concepts](./docs/concepts.md)
- [Adapters](./docs/adapters.md)
- [Recipes](./docs/recipes.md)
- [FAQ](./docs/faq.md)

Korean versions:

- [시작하기](./docs/getting-started.ko.md)
- [개념](./docs/concepts.ko.md)
- [어댑터](./docs/adapters.ko.md)
- [레시피](./docs/recipes.ko.md)
- [FAQ](./docs/faq.ko.md)

## Local Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The demo app is in `apps/demo`. It uses MikroORM, PostgreSQL, Redis, and the
published package APIs the same way a consuming Nest application would.

```bash
docker compose up -d
pnpm --filter @nest-batch/demo migration:up
pnpm --filter @nest-batch/demo start
```

## License

MIT
