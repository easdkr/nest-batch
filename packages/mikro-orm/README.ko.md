# @nest-batch/mikro-orm

`@nest-batch/core`용 MikroORM persistence adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm @mikro-orm/core @mikro-orm/nestjs
```

애플리케이션에서 사용하는 MikroORM driver도 함께 설치하세요. PostgreSQL이라면
`@mikro-orm/postgresql`을 사용합니다.

## Public Import

```ts
import {
  BATCH_META_ENTITIES,
  MikroOrmAdapter,
  MikroORMJobRepository,
  MikroORMTransactionManager,
} from '@nest-batch/mikro-orm';
```

## Wiring

`MikroOrmModule.forRoot`는 host application이 소유합니다. exported batch metadata
entity를 기존 entity 목록에 추가하세요.

```ts
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES, MikroOrmAdapter } from '@nest-batch/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      driver: PostgreSqlDriver,
      dbName: process.env.DB_NAME,
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MikroOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

마이그레이션은 애플리케이션의 MikroORM migration flow로 생성하고 실행합니다.
