import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from '../src/entities/job-meta.entities';
import { CreateBatchMeta1700000000000 } from '../src/migrations/1700000000000-CreateBatchMeta';

/**
 * Build a fresh TypeORM 1.0.0 DataSource for tests.
 *
 * Mode selection is env-aware:
 *
 * - If `DB_HOST` (or `DATABASE_URL`) is set, the data source connects
 *   to PostgreSQL using the standard `DB_*` env vars. This unlocks
 *   PG-specific semantics like `FOR UPDATE SKIP LOCKED` that the
 *   contract suite depends on.
 * - Otherwise, the data source falls back to an in-memory
 *   `better-sqlite3` database for fast, hermetic test runs.
 *
 * Both modes use `synchronize: true` to materialize the entity
 * metadata against an empty database — the test path does NOT go
 * through the migration file (which is the production setup path).
 *
 * Each caller should call `dataSource.destroy()` in teardown to
 * release the underlying handle / connection.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const entities = [
    JobInstanceEntity,
    JobExecutionEntity,
    StepExecutionEntity,
    JobExecutionContextEntity,
    StepExecutionContextEntity,
  ];

  const usePostgres = Boolean(process.env.DB_HOST || process.env.DATABASE_URL);

  const dataSource = new DataSource(
    usePostgres
      ? {
          type: 'postgres',
          host: process.env.DB_HOST ?? '127.0.0.1',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USER ?? 'demo',
          password: process.env.DB_PASSWORD ?? 'demo',
          database: process.env.DB_NAME ?? 'nest_batch_test',
          dropSchema: true,
          synchronize: false,
          migrations: [CreateBatchMeta1700000000000],
          migrationsRun: true,
          logging: false,
          entities,
        }
      : {
          type: 'better-sqlite3',
          database: ':memory:',
          dropSchema: true,
          synchronize: true,
          logging: false,
          entities,
        },
  );
  // The entities declare `datetime` for portability (see
  // job-meta.entities.ts) but TypeORM's `EntityMetadataValidator`
  // rejects `datetime` against the postgres driver at
  // `buildMetadatas()` time, before `migrationsRun` runs. The actual
  // schema is built by the `CreateBatchMeta1700000000000` migration
  // using `timestamptz`, so the validator's static type check is the
  // only blocker. Extend the driver whitelist in place — the
  // PostgresDriver instance is already constructed by `new DataSource()`.
  if (usePostgres) {
    (dataSource.driver as unknown as { supportedDataTypes: string[] }).supportedDataTypes.push(
      'datetime',
    );
  }
  await dataSource.initialize();
  return dataSource;
}
