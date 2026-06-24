# @nest-batch/deployment

Deployment recipes and IaC helper objects for nest-batch runtime adapters.

## Install

```bash
pnpm add @nest-batch/deployment
```

## What this package provides

- Deployment recipe helpers exported from `recipes`
- Shared typed objects for infrastructure-oriented package examples

Use this package as a small companion for deployment wiring. It does not include
the core batch runtime and does not deploy cloud resources by itself.

## Build and test

```bash
pnpm --filter @nest-batch/deployment build
pnpm --filter @nest-batch/deployment test
pnpm --filter @nest-batch/deployment typecheck
```
