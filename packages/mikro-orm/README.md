# @nest-batch/mikro-orm

MikroORM persistence adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm @mikro-orm/core @mikro-orm/nestjs
```

Install the MikroORM driver your application uses, for example
`@mikro-orm/postgresql` for PostgreSQL.

## Public Imports

```ts
import {
  BATCH_META_ENTITIES,
  MikroOrmAdapter,
  MikroORMJobRepository,
  MikroORMTransactionManager,
} from '@nest-batch/mikro-orm';
```

## Wiring

The host application owns `MikroOrmModule.forRoot`. Add the exported batch
metadata entities to your normal entity list.

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

Generate and run migrations with your application's MikroORM migration flow.
