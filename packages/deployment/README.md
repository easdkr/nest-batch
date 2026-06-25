# @nest-batch/deployment

Typed deployment recipe helpers for `nest-batch` runtime adapters.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/deployment
```

## Public Imports

```ts
import {
  createAwsBatchRecipe,
  createEcsFargateRecipe,
  createKubernetesJobRecipe,
  createSqsEventBridgeRecipe,
  type DeploymentRecipe,
} from '@nest-batch/deployment';
```

## Usage

```ts
const recipe = createEcsFargateRecipe({
  clusterArn: process.env.ECS_CLUSTER_ARN,
  taskDefinitionArn: process.env.ECS_TASK_DEFINITION_ARN,
  taskRoleArn: process.env.ECS_TASK_ROLE_ARN,
  executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN,
  subnets: process.env.ECS_SUBNETS.split(','),
});
```

The returned object is plain JSON-friendly data you can pass to documentation,
infrastructure generators, or internal deployment tooling.
