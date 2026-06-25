# @nest-batch/aws-eventbridge-scheduler

`@nest-batch/core` schedule을 위한 AWS EventBridge Scheduler integration입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/aws-eventbridge-scheduler
```

`createSchedule(input)` method를 가진 client object를 제공하세요. AWS SDK
EventBridge Scheduler client를 감싼 wrapper여도 됩니다.

## Public Import

```ts
import {
  EventBridgeScheduler,
  EventBridgeSchedulerModule,
  type EventBridgeSchedulerModuleOptions,
} from '@nest-batch/aws-eventbridge-scheduler';
```

## Wiring

`NestBatchModule` 옆에 module을 추가합니다. application bootstrap 시점에 발견된
`@BatchScheduled` entry를 읽습니다.

```ts
import { EventBridgeSchedulerModule } from '@nest-batch/aws-eventbridge-scheduler';

@Module({
  imports: [
    NestBatchModule.forRoot({ adapters }),
    EventBridgeSchedulerModule.forRoot({
      client: schedulerClient,
      groupName: 'orders',
      target: {
        Arn: process.env.SCHEDULER_TARGET_ARN,
        RoleArn: process.env.SCHEDULER_ROLE_ARN,
      },
    }),
  ],
})
export class AppModule {}
```
