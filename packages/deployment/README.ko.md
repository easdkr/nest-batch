# @nest-batch/deployment

`nest-batch` runtime adapter를 위한 typed deployment recipe helper입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/deployment
```

## Public Import

```ts
import {
  createAwsBatchRecipe,
  createEcsFargateRecipe,
  createKubernetesJobRecipe,
  createSqsEventBridgeRecipe,
  type DeploymentRecipe,
} from '@nest-batch/deployment';
```

## 사용

```ts
const recipe = createEcsFargateRecipe({
  clusterArn: process.env.ECS_CLUSTER_ARN,
  taskDefinitionArn: process.env.ECS_TASK_DEFINITION_ARN,
  taskRoleArn: process.env.ECS_TASK_ROLE_ARN,
  executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN,
  subnets: process.env.ECS_SUBNETS.split(','),
});
```

반환값은 documentation, infrastructure generator, internal deployment tooling에
전달하기 좋은 JSON-friendly data입니다.
