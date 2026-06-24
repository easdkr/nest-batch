# @nest-batch/admin

Nest-native admin API and lightweight dashboard helpers for
`@nest-batch/core`.

## Install

```bash
pnpm add @nest-batch/admin @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `BatchAdminModule`
- `BatchAdminController`
- `BatchAdminRenderer`

Use this package when a Nest application needs a small HTTP admin surface for
batch job inspection and operation. The batch runtime, repository contracts,
job definitions, and execution semantics stay in `@nest-batch/core`.

## Build and test

```bash
pnpm --filter @nest-batch/admin build
pnpm --filter @nest-batch/admin test
pnpm --filter @nest-batch/admin typecheck
```
