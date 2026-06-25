# @nest-batch/aws-batch

AWS Batch submit-job adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/aws-batch
```

Provide a client object with a `submitJob(input)` method. It can wrap the AWS
SDK Batch client.

## Public Imports

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
