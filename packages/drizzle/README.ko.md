# @nest-batch/drizzle

`@nest-batch/core`용 Drizzle persistence adapter slot입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/drizzle drizzle-orm
```

driver-specific schema와 runtime binding이 필요하면 `@nest-batch/postgresql` 또는
`@nest-batch/mysql`과 함께 사용합니다.

## Public Import

```ts
import {
  DrizzleAdapter,
  DrizzleDriverProvider,
  DrizzleJobRepository,
  DrizzleTransactionManager,
} from '@nest-batch/drizzle';
```

## Wiring

Drizzle database instance와 migration flow는 host application이 소유합니다.

```ts
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { DrizzleAdapter } from '@nest-batch/drizzle';

NestBatchModule.forRoot({
  adapters: {
    persistence: DrizzleAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

PostgreSQL/MySQL table definition은 matching driver package에서 import합니다.

```ts
import { postgresDrizzleSchema } from '@nest-batch/postgresql';
import { mysqlDrizzleSchema } from '@nest-batch/mysql';
```
