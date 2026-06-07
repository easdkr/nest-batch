/**
 * Vitest global setup — runs every pending batch-meta migration
 * against the test database, then idempotently backfills the
 * `params` column for DBs that pre-date migration 006.
 *
 * Without this, the contract suite fails with
 * `42P01 — relation "batch_*" does not exist` on a fresh CI
 * database (the Postgres service container in `ci.yml` ships
 * with the configured DB created but no schema). The typeorm
 * equivalent is `migrationsRun: true` in
 * `packages/typeorm/tests/create-test-data-source.ts`; we do the
 * same here by booting the full MikroORM (with entities +
 * Migrator extension + migrations path) and calling `up()`.
 *
 * Both the migration run and the ALTER use `IF (NOT) EXISTS`
 * semantics, so re-running against a DB that already has the
 * schema is a no-op.
 */
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { BATCH_META_ENTITIES } from '../src/entities/job-meta.entities';

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
    entities: BATCH_META_ENTITIES,
    extensions: [Migrator],
    migrations: {
      path: 'src/migrations',
      pathTs: 'src/migrations',
    },
  });

  // Run every pending migration. The Migrator's `up()` is a no-op
  // when the DB is already at the latest version, so this is safe
  // to call on every CI run and every local re-run.
  const migrator = orm.getMigrator();
  const pending = await migrator.getPendingMigrations();
  if (pending.length > 0) {
    await migrator.up();
  }

  await orm.close();
}
