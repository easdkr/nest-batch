import { defineConfig } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { JobInstanceEntity, JobExecutionEntity, JobExecutionParamsEntity, StepExecutionEntity, JobExecutionContextEntity, StepExecutionContextEntity } from './src/entities/job-meta.entities';
import { ProductEntity } from './src/entities/product.entity';

export default defineConfig({
  driver: PostgreSqlDriver,
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  entities: [
    JobInstanceEntity,
    JobExecutionEntity,
    JobExecutionParamsEntity,
    StepExecutionEntity,
    JobExecutionContextEntity,
    StepExecutionContextEntity,
    ProductEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: './src/migrations',
    pathTs: './src/migrations',
  },
});
