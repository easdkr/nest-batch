# @nest-batch/aws-sqs

AWS SQS transport adapter for `@nest-batch/core`.

## Install

```bash
pnpm add @nest-batch/aws-sqs @nest-batch/core
```

Peer dependencies:

- `@nest-batch/core@^0.2.0`
- `@nestjs/common@^10 || ^11`
- `@nestjs/core@^10 || ^11`

## What this package provides

- `SqsAdapter`
- `SqsExecutionStrategy`
- SQS module option types

Use this package when batch execution should be handed off through SQS. The
package provides the transport bridge only; job definitions, repository
contracts, status transitions, and chunk semantics stay in `@nest-batch/core`.

## Build and test

```bash
pnpm --filter @nest-batch/aws-sqs build
pnpm --filter @nest-batch/aws-sqs test
pnpm --filter @nest-batch/aws-sqs typecheck
```
