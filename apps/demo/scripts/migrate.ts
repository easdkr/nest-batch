/**
 * Programmatic migration runner — avoids the MikroORM CLI's config-file
 * resolution issues by instantiating the ORM + Migrator directly.
 * Usage: `pnpm exec tsx scripts/migrate.ts up`
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { JobInstanceEntity, JobExecutionEntity, JobExecutionParamsEntity, StepExecutionEntity, JobExecutionContextEntity, StepExecutionContextEntity } from '../src/entities/job-meta.entities';
import { ProductEntity } from '../src/entities/product.entity';

async function main() {
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5434),
    user: process.env.DATABASE_USER ?? 'demo',
    password: process.env.DATABASE_PASSWORD ?? 'demo',
    entities: [JobInstanceEntity, JobExecutionEntity, JobExecutionParamsEntity, StepExecutionEntity, JobExecutionContextEntity, StepExecutionContextEntity, ProductEntity],
    extensions: [Migrator],
    migrations: {
      path: './src/migrations',
      pathTs: './src/migrations',
    },
  });
  const migrator = orm.getMigrator();
  const pending = await migrator.getPendingMigrations();
  console.log(`Pending migrations: ${pending.length}`);
  if (pending.length > 0) {
    await migrator.up();
    console.log('All migrations applied.');
  } else {
    console.log('Nothing to migrate.');
  }
  await orm.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
