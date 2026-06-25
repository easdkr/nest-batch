# @nest-batch/prisma

Prisma persistence adapter slot for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/prisma @prisma/client
pnpm add -D prisma
```

Pair it with `@nest-batch/postgresql` or `@nest-batch/mysql` when you use the
driver shell packages.

## Public Imports

```ts
import {
  PrismaAdapter,
  PrismaDriverProvider,
  PrismaJobRepository,
  PrismaTransactionManager,
} from '@nest-batch/prisma';
```

## Wiring

The host application owns the Prisma schema, generated client, and migrations.
Add the batch metadata models to your schema and run `prisma generate`.

```ts
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { PrismaAdapter } from '@nest-batch/prisma';

NestBatchModule.forRoot({
  adapters: {
    persistence: PrismaAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

Bind your generated `PrismaClient` in the same Nest application so the adapter
repositories can use it.
