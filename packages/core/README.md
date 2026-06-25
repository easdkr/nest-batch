# @nest-batch/core

Core batch engine for NestJS. This package provides the public job model,
decorators, launcher/explorer/operator services, in-process transport, and the
adapter contracts used by the `@nest-batch/*` package family.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core reflect-metadata
```

Peer dependencies:

- `@nestjs/common` `^10 || ^11`
- `@nestjs/core` `^10 || ^11`
- `reflect-metadata` `^0.2`

## Public Imports

```ts
import {
  Batch,
  BatchScheduled,
  InProcessAdapter,
  JobExplorer,
  JobLauncher,
  JobOperator,
  NestBatchModule,
} from '@nest-batch/core';
```

Use the `Batch` namespace for decorators such as `Batch.Jobable`,
`Batch.Stepable`, `Batch.Tasklet`, `Batch.ItemReader`, `Batch.ItemProcessor`,
`Batch.ItemWriter`, and listener decorators.

## Module Wiring

Core requires one persistence adapter and one transport adapter.

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

`InProcessAdapter` is included in this package. Other transport adapters are
available as sibling packages.

## Define a Job

```ts
import { Injectable } from '@nestjs/common';
import { Batch } from '@nest-batch/core';

@Injectable()
@Batch.Jobable({ id: 'send-digest', restartable: true })
export class SendDigestJob {
  @Batch.Stepable({ id: 'send' })
  @Batch.Tasklet()
  async send(): Promise<void> {
    await sendDigestEmails();
  }
}
```

Register the job class as a Nest provider. `NestBatchModule` discovers
registered `@Batch.Jobable` providers when the application boots.

## Launch and Inspect

```ts
await jobLauncher.launch('send-digest', { businessDate: '2026-06-25' });

const executions = await jobExplorer.listJobExecutions({
  status: 'COMPLETED',
});
```

`JobLauncher` starts work, `JobExplorer` reads durable state, and `JobOperator`
provides stop, restart, abandon, and start-next-instance operations.
