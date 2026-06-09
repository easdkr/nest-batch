import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the six Spring Batch-compatible meta-tables for PostgreSQL:
 *
 *   - batch_job_instance            (root, unique on (job_name, job_key))
 *   - batch_job_execution           (one per job run, indexed by instance)
 *   - batch_step_execution          (one per step run, indexed by exec)
 *   - batch_job_execution_context   (JSON payload + version, keyed by exec)
 *   - batch_step_execution_context  (JSON payload + version, keyed by step)
 *
 * This is the consolidated 6-table Postgres DDL that the
 * `@nest-batch/postgresql` driver sibling ships. The
 * `@nest-batch/mikro-orm` and `@nest-batch/typeorm` slot packages
 * reference these column names from their slot-shaped repositories
 * (via the *DriverProvider token binding the host-owned connection).
 *
 * The `params` column on `batch_job_execution` is a JSON snapshot
 * stored as `text` to keep the schema portable and always
 * serialized (never queried structurally).
 */
export class CreateBatchMeta1700000000000 implements MigrationInterface {
  name = 'CreateBatchMeta1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // batch_job_instance — root of the meta-graph; (job_name, job_key) is unique.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_job_instance" (
        "id" varchar(255) PRIMARY KEY,
        "job_name" varchar(255) NOT NULL,
        "job_key" varchar(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "batch_job_instance_job_name_job_key_unique" UNIQUE ("job_name", "job_key")
      )
    `);

    // batch_job_execution — one row per job run; indexed by job_instance_id for lookup.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_job_execution" (
        "id" varchar(255) PRIMARY KEY,
        "job_instance_id" varchar(255) NOT NULL,
        "status" varchar(20) NOT NULL,
        "start_time" timestamptz NULL,
        "end_time" timestamptz NULL,
        "exit_code" varchar(255) NOT NULL DEFAULT '',
        "exit_message" text NOT NULL DEFAULT '',
        "params" text NOT NULL DEFAULT '{}'
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "batch_job_execution_job_instance_id_index"
      ON "batch_job_execution" ("job_instance_id")
    `);

    // batch_step_execution — counters default to 0; created_at powers findLatestStepExecution.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_step_execution" (
        "id" varchar(255) PRIMARY KEY,
        "job_execution_id" varchar(255) NOT NULL,
        "step_name" varchar(255) NOT NULL,
        "status" varchar(20) NOT NULL,
        "read_count" int NOT NULL DEFAULT 0,
        "write_count" int NOT NULL DEFAULT 0,
        "skip_count" int NOT NULL DEFAULT 0,
        "rollback_count" int NOT NULL DEFAULT 0,
        "commit_count" int NOT NULL DEFAULT 0,
        "exit_code" varchar(255) NOT NULL DEFAULT '',
        "exit_message" text NOT NULL DEFAULT '',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "batch_step_execution_job_execution_id_index"
      ON "batch_step_execution" ("job_execution_id")
    `);

    // batch_job_execution_context — JSON payload + version for optimistic concurrency.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_job_execution_context" (
        "job_execution_id" varchar(255) PRIMARY KEY,
        "data" text NOT NULL,
        "version" int NOT NULL DEFAULT 0
      )
    `);

    // batch_step_execution_context — same shape, scoped to a step.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_step_execution_context" (
        "step_execution_id" varchar(255) PRIMARY KEY,
        "data" text NOT NULL,
        "version" int NOT NULL DEFAULT 0
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse-dependency order: children first.
    await queryRunner.query(`DROP TABLE IF EXISTS "batch_step_execution_context"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "batch_job_execution_context"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "batch_step_execution"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "batch_job_execution"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "batch_job_instance"`);
  }
}
