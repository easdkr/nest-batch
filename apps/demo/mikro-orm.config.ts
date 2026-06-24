import type { Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import { ProductEntity } from './src/entities/product.entity';

export default {
  driver: PostgreSqlDriver,
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  entities: [ProductEntity, ...BATCH_META_ENTITIES],
} satisfies Options;
