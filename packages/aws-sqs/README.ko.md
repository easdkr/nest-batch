# @nest-batch/aws-sqs

`@nest-batch/core`용 AWS SQS transport adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/aws-sqs
```

애플리케이션에서 사용하는 AWS SDK client wrapper를 설치하고 제공하세요.

## Public Import

```ts
import { SqsAdapter, SqsExecutionStrategy, type SqsModuleOptions } from '@nest-batch/aws-sqs';
```

## Wiring

```ts
import { SqsAdapter } from '@nest-batch/aws-sqs';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: SqsAdapter.forRoot({
      client: sqsClient,
      queueUrl: process.env.BATCH_QUEUE_URL,
      fifo: true,
      workerCommand: ['node', 'dist/batch-worker.js'],
    }),
  },
});
```

adapter는 batch work message를 serialize해서 SQS로 보냅니다. SQS message를 받고
batch worker command를 호출하는 runtime은 애플리케이션이 운영합니다.
