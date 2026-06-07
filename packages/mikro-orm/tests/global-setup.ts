/**
 * Vitest global setup — ensures the `batch_job_execution.params` column
 * exists before any test file runs.  This avoids deadlocks that occur
 * when multiple parallel test files try to ALTER TABLE simultaneously
 * in their `beforeAll` hooks.
 */
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/core';

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_mikro',
};

export default async function setup() {
  const orm = await MikroORM.init({
    ...PG_CONFIG,
    driver: PostgreSqlDriver,
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  const em = orm.em.fork() as unknown as SqlEntityManager;
  await em.execute(`
    ALTER TABLE "batch_job_execution"
    ADD COLUMN IF NOT EXISTS "params" text NOT NULL DEFAULT '{}'
  `);
  await orm.close();
}
