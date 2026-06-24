# @nest-batch/kubernetes

Kubernetes Job one-off execution adapter for `@nest-batch/core`.

## Install

```bash
pnpm add @nest-batch/kubernetes @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `KubernetesJobAdapter`
- `KubernetesJobLauncher`
- Kubernetes Job module option types

Use this package when a launcher service should create one-off Kubernetes Jobs
for batch work. The package does not create Kubernetes clusters, RBAC, service
accounts, or persistence tables.

## Build and test

```bash
pnpm --filter @nest-batch/kubernetes build
pnpm --filter @nest-batch/kubernetes test
pnpm --filter @nest-batch/kubernetes typecheck
```
