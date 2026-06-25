# @nest-batch/core

NestJS용 batch engine core입니다. job model, decorator, launcher/explorer/operator
service, in-process transport, 그리고 `@nest-batch/*` 패키지들이 사용하는 adapter
contract를 제공합니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core reflect-metadata
```

peer dependency:

- `@nestjs/common` `^10 || ^11`
- `@nestjs/core` `^10 || ^11`
- `reflect-metadata` `^0.2`

## Public Import

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

`Batch.Jobable`, `Batch.Stepable`, `Batch.Tasklet`, `Batch.ItemReader`,
`Batch.ItemProcessor`, `Batch.ItemWriter`, listener decorator는 `Batch` namespace로
사용합니다.

## Module Wiring

core에는 persistence adapter 하나와 transport adapter 하나가 필요합니다.

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

`InProcessAdapter`는 이 패키지에 포함되어 있습니다. 다른 transport adapter는 sibling
package로 제공합니다.

## Job 정의

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

job class를 Nest provider로 등록하면 application boot 시점에 `NestBatchModule`이
`@Batch.Jobable` provider를 발견합니다.

## 실행과 조회

```ts
await jobLauncher.launch('send-digest', { businessDate: '2026-06-25' });

const executions = await jobExplorer.listJobExecutions({
  status: 'COMPLETED',
});
```

`JobLauncher`는 작업을 시작하고, `JobExplorer`는 durable state를 읽으며,
`JobOperator`는 stop, restart, abandon, start-next-instance operation을 제공합니다.
