# @nest-batch/mysql

MySQL driver shells for the `@nest-batch/*` persistence adapters.

Korean: [README.ko.md](./README.ko.md)

## Install

Install this package with the ORM adapter you use.

```bash
pnpm add @nest-batch/core @nest-batch/mysql @nest-batch/drizzle mysql2
```

Other combinations are supported with `@nest-batch/mikro-orm`,
`@nest-batch/typeorm`, or `@nest-batch/prisma`.

## Public Imports

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

Choose the shell that matches your ORM adapter.

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

The host still owns the MySQL connection, ORM bootstrap, and migrations. For
Drizzle, use `mysqlDrizzleSchema` when creating your Drizzle database and
migration files.
