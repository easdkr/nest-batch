# @nest-batch/aws-sqs

AWS SQS transport adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/aws-sqs
```

Install and provide the AWS SDK client wrapper used by your application.

## Public Imports

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

The adapter serializes a batch work message and sends it to SQS. Your worker
runtime is responsible for receiving the SQS message and invoking the batch
worker command.
