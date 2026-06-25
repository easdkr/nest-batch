# @nest-batch/aws-eventbridge-scheduler

AWS EventBridge Scheduler integration for `@nest-batch/core` schedules.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/aws-eventbridge-scheduler
```

Provide a client object with a `createSchedule(input)` method. It can wrap the
AWS SDK EventBridge Scheduler client.

## Public Imports

```ts
import {
  EventBridgeScheduler,
  EventBridgeSchedulerModule,
  type EventBridgeSchedulerModuleOptions,
} from '@nest-batch/aws-eventbridge-scheduler';
```

## Wiring

Add the module alongside `NestBatchModule`. It reads discovered
`@BatchScheduled` entries during application bootstrap.

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
