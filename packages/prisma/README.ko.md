# @nest-batch/prisma

`@nest-batch/core`용 Prisma persistence adapter slot입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/prisma @prisma/client
pnpm add -D prisma
```

driver shell package를 사용할 때는 `@nest-batch/postgresql` 또는
`@nest-batch/mysql`과 함께 사용합니다.

## Public Import

```ts
import {
  PrismaAdapter,
  PrismaDriverProvider,
  PrismaJobRepository,
  PrismaTransactionManager,
} from '@nest-batch/prisma';
```

## Wiring

Prisma schema, generated client, migration은 host application이 소유합니다. batch
metadata model을 schema에 추가하고 `prisma generate`를 실행하세요.

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

adapter repository가 사용할 수 있도록 generated `PrismaClient`를 같은 Nest
application에 바인딩하세요.
