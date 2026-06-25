# @nest-batch/aws-ecs

`@nest-batch/core`용 AWS ECS Fargate one-off task adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/aws-ecs
```

`runTask(input)` method를 가진 작은 client object를 제공하세요. 기존 AWS SDK ECS
client를 감싼 wrapper여도 됩니다.

## Public Import

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

adapter는 Fargate task를 시작하고 job id, job execution id, parameters를 worker
command로 전달합니다.
