# @nest-batch/drizzle

Drizzle persistence adapter slot for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/drizzle drizzle-orm
```

Pair it with `@nest-batch/postgresql` or `@nest-batch/mysql` when you need
driver-specific schema and runtime bindings.

## Public Imports

```ts
import {
  DrizzleAdapter,
  DrizzleDriverProvider,
  DrizzleJobRepository,
  DrizzleTransactionManager,
} from '@nest-batch/drizzle';
```

## Wiring

The host application owns the Drizzle database instance and migration flow.

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

For PostgreSQL and MySQL table definitions, import the schema from the matching
driver package:

```ts
import { postgresDrizzleSchema } from '@nest-batch/postgresql';
import { mysqlDrizzleSchema } from '@nest-batch/mysql';
```
