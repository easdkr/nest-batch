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

Scheduler 정의는 Redis/Valkey에 저장되는 공유 상태입니다. 각 application instance는
부팅할 때 원하는 scheduler를 upsert하지만, 종료할 때는 해당 instance의 worker와
connection만 닫습니다. 삭제되거나 이름이 바뀐 schedule은 명시적 cleanup 또는 별도의
desired-state reconciliation으로 정리해야 합니다.

`0.2.3`에서 업그레이드할 때는 기존 task가 종료되며 scheduler 정의를 마지막으로 삭제할
수 있습니다. 최초 한 번은 stop-before-start 방식(`0 -> 1`)으로 배포하거나 배포 완료 후
schedule을 명시적으로 재등록해야 합니다. 모든 실행 task가 수정 버전을 사용한 이후에는
일반 rolling deployment가 안전합니다.
