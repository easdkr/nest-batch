# @nest-batch/aws-ecs

AWS ECS Fargate one-off task adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/aws-ecs
```

Provide a small client object with a `runTask(input)` method. It can wrap the
AWS SDK ECS client you already use.

## Public Imports

```ts
import {
  EcsFargateAdapter,
  EcsFargateTaskLauncher,
  type EcsFargateModuleOptions,
} from '@nest-batch/aws-ecs';
```

## Wiring

```ts
import { EcsFargateAdapter } from '@nest-batch/aws-ecs';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: EcsFargateAdapter.forRoot({
      client: ecsRunTaskClient,
      cluster: process.env.ECS_CLUSTER_ARN,
      taskDefinition: process.env.ECS_TASK_DEFINITION_ARN,
      containerName: 'batch-worker',
      networkConfiguration: {
        subnets: process.env.ECS_SUBNETS.split(','),
        securityGroups: process.env.ECS_SECURITY_GROUPS.split(','),
      },
      workerCommand: ['node', 'dist/batch-worker.js'],
    }),
  },
});
```

The adapter starts a Fargate task and passes the job id, job execution id, and
parameters to the worker command.
