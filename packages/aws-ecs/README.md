# @nest-batch/aws-ecs

AWS ECS Fargate one-off task adapter for `@nest-batch/core`.

## Install

```bash
pnpm add @nest-batch/aws-ecs @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `EcsFargateAdapter`
- `EcsFargateTaskLauncher`
- ECS Fargate module option types

Use this package when a launcher service should start one-off ECS Fargate tasks
for batch work. The package does not create clusters, task definitions, IAM
roles, or persistence tables.

## Build and test

```bash
pnpm --filter @nest-batch/aws-ecs build
pnpm --filter @nest-batch/aws-ecs test
pnpm --filter @nest-batch/aws-ecs typecheck
```
