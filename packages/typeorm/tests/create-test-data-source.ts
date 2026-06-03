import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from '../src/entities/job-meta.entities';

/**
 * Build a fresh in-memory TypeORM 1.0.0 DataSource for tests.
 *
 * Uses better-sqlite3 with `:memory:` so the database lives only
 * for the test process. `synchronize: true` runs the entity
 * metadata against the empty database to materialize the schema —
 * the test path does NOT go through the migration file (which is
 * the production setup path).
 *
 * Each caller should call `dataSource.destroy()` in teardown to
 * release the SQLite handle.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    dropSchema: true,
    synchronize: true,
    logging: false,
    entities: [
      JobInstanceEntity,
      JobExecutionEntity,
      StepExecutionEntity,
      JobExecutionContextEntity,
      StepExecutionContextEntity,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}
