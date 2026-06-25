# @nest-batch/postgresql

`@nest-batch/*` persistence adapter를 위한 PostgreSQL driver shell 패키지입니다.

English: [README.md](./README.md)

## 설치

사용하는 ORM adapter와 함께 설치합니다.

```bash
pnpm add @nest-batch/core @nest-batch/postgresql @nest-batch/mikro-orm pg
```

`@nest-batch/typeorm`, `@nest-batch/drizzle`, `@nest-batch/prisma` 조합도
지원합니다.

## Public Import

```ts
import {
  PostgresMikroOrmAdapter,
  PostgresTypeOrmAdapter,
  PostgresDrizzleAdapter,
  postgresDrizzleSchema,
  PostgresPrismaAdapter,
} from '@nest-batch/postgresql';
```

## Wiring

ORM adapter에 맞는 shell을 선택합니다.

```ts
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { PostgresMikroOrmAdapter } from '@nest-batch/postgresql';

NestBatchModule.forRoot({
  adapters: {
    persistence: PostgresMikroOrmAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

PostgreSQL connection, ORM bootstrap, migration은 여전히 host가 소유합니다.
MikroORM은 `@nest-batch/mikro-orm`의 `BATCH_META_ENTITIES`를 포함하세요.
Drizzle은 Drizzle database와 migration을 만들 때 `postgresDrizzleSchema`를
사용합니다.
