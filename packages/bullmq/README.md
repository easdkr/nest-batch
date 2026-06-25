# @nest-batch/bullmq

BullMQ transport adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/bullmq bullmq ioredis
```

## Public Imports

```ts
import { BullmqAdapter, BullMqExecutionStrategy, BULLMQ_MODULE_OPTIONS } from '@nest-batch/bullmq';
```

## Wiring

Use BullMQ when the launcher should enqueue work and a worker should consume it
through Redis.

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

Run the same application image in launcher and worker roles:

```bash
BATCH_WORKER=0 node dist/main.js
BATCH_WORKER=1 node dist/main.js
```

## Scheduling

When `autoStartWorker` is enabled, this package can also bridge discovered
`@BatchScheduled` entries into job launches.
