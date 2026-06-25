# @nest-batch/postgresql

PostgreSQL driver shells for the `@nest-batch/*` persistence adapters.

Korean: [README.ko.md](./README.ko.md)

## Install

Install this package with the ORM adapter you use.

```bash
pnpm add @nest-batch/core @nest-batch/postgresql @nest-batch/mikro-orm pg
```

Other combinations are supported with `@nest-batch/typeorm`,
`@nest-batch/drizzle`, or `@nest-batch/prisma`.

## Public Imports

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

Choose the shell that matches your ORM adapter.

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

The host still owns the PostgreSQL connection, ORM bootstrap, and migrations.
For MikroORM, include `BATCH_META_ENTITIES` from `@nest-batch/mikro-orm`. For
Drizzle, use `postgresDrizzleSchema` when creating your Drizzle database and
migration files.
