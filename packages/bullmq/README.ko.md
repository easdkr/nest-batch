# @nest-batch/bullmq

`@nest-batch/core`용 BullMQ transport adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/bullmq bullmq ioredis
```

## Public Import

```ts
import { BullmqAdapter, BullMqExecutionStrategy, BULLMQ_MODULE_OPTIONS } from '@nest-batch/bullmq';
```

## Wiring

launcher는 Redis에 작업을 enqueue하고 worker가 consume해야 할 때 BullMQ를 사용합니다.

```ts
import { BullmqAdapter } from '@nest-batch/bullmq';
import { NestBatchModule } from '@nest-batch/core';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: BullmqAdapter.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT ?? 6379),
        keyPrefix: 'my-app:',
      },
      autoStartWorker: process.env.BATCH_WORKER === '1',
    }),
  },
});
```

같은 application image를 launcher와 worker role로 실행할 수 있습니다.

```bash
BATCH_WORKER=0 node dist/main.js
BATCH_WORKER=1 node dist/main.js
```

## Scheduling

`autoStartWorker`가 활성화되면 이 패키지는 발견된 `@BatchScheduled` entry를 job
launch로 연결할 수 있습니다.
