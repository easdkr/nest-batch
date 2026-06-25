# @nest-batch/typeorm

`@nest-batch/core`용 TypeORM persistence adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/typeorm typeorm
```

Nest 애플리케이션에서 `@nestjs/typeorm`을 사용한다면 기존 `TypeOrmModule.forRoot`
구성을 그대로 소유하면 됩니다.

## Public Import

```ts
import {
  BATCH_META_ENTITIES,
  TypeOrmAdapter,
  TypeOrmJobRepository,
  TypeOrmTransactionManager,
  batchMetaEntities,
} from '@nest-batch/typeorm';
```

## Wiring

host-owned TypeORM data source에 batch metadata entity를 등록합니다.

```ts
import { TypeOrmModule } from '@nestjs/typeorm';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES, TypeOrmAdapter } from '@nest-batch/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      url: process.env.DATABASE_URL,
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: TypeOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

metadata entity를 추가한 뒤 application repository에서 migration을 생성하세요.
