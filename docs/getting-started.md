# Getting Started

This guide shows the shortest path from a Nest application to a working
`nest-batch` job.

## 1. Install Packages

Pick one persistence adapter and one transport adapter.

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm
```

For local execution, no extra transport package is required because
`InProcessAdapter` ships with `@nest-batch/core`.

For Redis-backed workers:

```bash
pnpm add @nest-batch/bullmq bullmq ioredis
```

## 2. Add Batch Metadata Tables

`nest-batch` stores job instances, job executions, step executions, and
execution contexts in your application database. The host application owns
its migration flow.

For MikroORM, include the exported metadata entities:

```ts
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';

MikroOrmModule.forRoot({
  entities: [UserEntity, ...BATCH_META_ENTITIES],
  // your normal database options
});
```

Then generate and run migrations with the same toolchain you already use for
your application.

## 3. Wire `NestBatchModule`

```ts
import { Module } from '@nestjs/common';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { MikroOrmAdapter } from '@nest-batch/mikro-orm';

@Module({
  imports: [
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

## 4. Define a Job

```ts
import { Injectable } from '@nestjs/common';
import { Batch } from '@nest-batch/core';

@Injectable()
@Batch.Jobable({ id: 'nightly-report', restartable: true })
export class NightlyReportJob {
  @Batch.Stepable({ id: 'build-report' })
  @Batch.Tasklet()
  async buildReport(): Promise<{ rows: number }> {
    return { rows: await buildReportRows() };
  }
}
```

Add `NightlyReportJob` to the module `providers` array.

## 5. Launch It

```ts
import { JobLauncher } from '@nest-batch/core';

await jobLauncher.launch('nightly-report', {
  businessDate: '2026-06-25',
});
```

The return value is the durable job execution snapshot. If you use an async
transport such as BullMQ, the first response usually reflects the queued
execution. Poll `JobExplorer` or your own endpoint for the terminal state.

## 6. Try the Demo

The repository includes a consumer app in `apps/demo`.

```bash
pnpm install --frozen-lockfile
pnpm build
docker compose up -d
pnpm --filter @nest-batch/demo migration:up
pnpm --filter @nest-batch/demo start
```

Launch the demo import job:

```bash
curl -X POST http://localhost:3000/jobs/import-products \
  -H 'content-type: application/json' \
  -d '{"file":"sample-data/products-valid.csv"}'
```
