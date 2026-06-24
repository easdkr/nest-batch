# @nest-batch/aws-batch

AWS Batch submit-job adapter for `@nest-batch/core`.

## Install

```bash
pnpm add @nest-batch/aws-batch @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `AwsBatchAdapter`
- `AwsBatchJobLauncher`
- AWS Batch module option types

Use this package when a launcher service should submit batch work to AWS Batch.
The package is an execution adapter. It does not define jobs, own persistence,
or create AWS infrastructure.

## Build and test

```bash
pnpm --filter @nest-batch/aws-batch build
pnpm --filter @nest-batch/aws-batch test
pnpm --filter @nest-batch/aws-batch typecheck
```
