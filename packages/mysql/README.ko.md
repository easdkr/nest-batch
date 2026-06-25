# @nest-batch/mysql

`@nest-batch/*` persistence adapter를 위한 MySQL driver shell 패키지입니다.

English: [README.md](./README.md)

## 설치

사용하는 ORM adapter와 함께 설치합니다.

```bash
pnpm add @nest-batch/core @nest-batch/mysql @nest-batch/drizzle mysql2
```

`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/prisma` 조합도
지원합니다.

## Public Import

```ts
import {
  MysqlMikroOrmAdapter,
  MysqlTypeOrmAdapter,
  MysqlDrizzleAdapter,
  mysqlDrizzleSchema,
  MysqlPrismaAdapter,
} from '@nest-batch/mysql';
```

## Wiring

ORM adapter에 맞는 shell을 선택합니다.

```ts
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { MysqlDrizzleAdapter } from '@nest-batch/mysql';

NestBatchModule.forRoot({
  adapters: {
    persistence: MysqlDrizzleAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

MySQL connection, ORM bootstrap, migration은 여전히 host가 소유합니다. Drizzle은
Drizzle database와 migration을 만들 때 `mysqlDrizzleSchema`를 사용합니다.
