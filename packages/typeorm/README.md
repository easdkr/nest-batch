# @nest-batch/typeorm

TypeORM persistence adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/typeorm typeorm
```

If your Nest application uses `@nestjs/typeorm`, keep using your normal
`TypeOrmModule.forRoot` configuration.

## Public Imports

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

Register the batch metadata entities in your host-owned TypeORM data source.

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

Generate migrations in the application repository after adding the metadata
entities.
