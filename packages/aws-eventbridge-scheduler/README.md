# @nest-batch/aws-eventbridge-scheduler

AWS EventBridge Scheduler integration for `@nest-batch/core` schedules.

## Install

```bash
pnpm add @nest-batch/aws-eventbridge-scheduler @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `EventbridgeSchedulerModule`
- `EventBridgeScheduler`
- EventBridge Scheduler module option types

Use this package when scheduled batch definitions should be represented as AWS
EventBridge Scheduler resources. The package does not own the batch job
definition model or persistence layer; those remain in `@nest-batch/core` and
the selected repository adapter.

## Build and test

```bash
pnpm --filter @nest-batch/aws-eventbridge-scheduler build
pnpm --filter @nest-batch/aws-eventbridge-scheduler test
pnpm --filter @nest-batch/aws-eventbridge-scheduler typecheck
```
