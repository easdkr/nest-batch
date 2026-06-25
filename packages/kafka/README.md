# @nest-batch/kafka

Kafka transport adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/kafka kafkajs
```

## Public Imports

```ts
import { KafkaAdapter, KafkaExecutionStrategy, KAFKA_MODULE_OPTIONS } from '@nest-batch/kafka';
```

## Wiring

```ts
import { KafkaAdapter } from '@nest-batch/kafka';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: KafkaAdapter.forRoot({
      connection: {
        brokers: ['localhost:9092'],
        clientId: 'orders-api',
      },
      topic: 'nest-batch-work',
      consumerGroupId: 'orders-batch-workers',
      autoStartConsumer: process.env.BATCH_WORKER === '1',
    }),
  },
});
```
