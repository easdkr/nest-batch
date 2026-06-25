# @nest-batch/kafka

`@nest-batch/core`용 Kafka transport adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/kafka kafkajs
```

## Public Import

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
