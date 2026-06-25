# @nest-batch/aws-batch

`@nest-batch/core`용 AWS Batch submit-job adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/aws-batch
```

`submitJob(input)` method를 가진 client object를 제공하세요. 기존 AWS SDK Batch
client를 감싼 wrapper여도 됩니다.

## Public Import

```ts
import {
  AwsBatchAdapter,
  AwsBatchJobLauncher,
  type AwsBatchModuleOptions,
} from '@nest-batch/aws-batch';
```

## Wiring

```ts
import { AwsBatchAdapter } from '@nest-batch/aws-batch';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: AwsBatchAdapter.forRoot({
      client: batchClient,
      jobQueue: process.env.AWS_BATCH_JOB_QUEUE,
      jobDefinition: process.env.AWS_BATCH_JOB_DEFINITION,
      jobNamePrefix: 'orders-batch',
      workerCommand: ['node', 'dist/batch-worker.js'],
    }),
  },
});
```
