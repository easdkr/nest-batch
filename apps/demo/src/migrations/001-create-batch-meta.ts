import { Migration } from '@mikro-orm/migrations';

/**
 * Creates the six Spring Batch-compatible meta-tables used by
 * nest-batch. BATCH_STEP_EXECUTION_PARAMS is intentionally omitted
 * per the ORACLE verdict 2b ("low-level aggregate-based methods")
 * and the Metis guardrail — step parameters are derivable from the
 * parent job execution params + the step execution context.
 *
 * Down-migration drops in reverse-dependency order (children first).
 */
export class CreateBatchMeta001 extends Migration {
  override async up(): Promise<void> {
    // batch_job_instance — root of the meta-graph; (jobName, jobKey) is unique.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_job_instance" (
      "id" varchar(255) PRIMARY KEY,
      "job_name" varchar(255) NOT NULL,
      "job_key" varchar(255) NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "batch_job_instance_job_name_job_key_unique" UNIQUE ("job_name", "job_key")
    );`);

    // batch_job_execution — one row per job run; indexed by jobInstanceId for lookup.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_job_execution" (
      "id" varchar(255) PRIMARY KEY,
      "job_instance_id" varchar(255) NOT NULL,
      "status" varchar(20) NOT NULL,
      "start_time" timestamptz NULL,
      "end_time" timestamptz NULL,
      "exit_code" varchar(255) NOT NULL DEFAULT '',
      "exit_message" text NOT NULL DEFAULT ''
    );`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "batch_job_execution_job_instance_id_index" ON "batch_job_execution" ("job_instance_id");`);

    // batch_job_execution_params — composite PK; longValue is varchar for bigint safety.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_job_execution_params" (
      "job_execution_id" varchar(255) NOT NULL,
      "param_name" varchar(255) NOT NULL,
      "param_type" varchar(20) NOT NULL,
      "string_value" text NULL,
      "date_value" timestamptz NULL,
      "long_value" varchar(255) NULL,
      "double_value" double precision NULL,
      PRIMARY KEY ("job_execution_id", "param_name")
    );`);

    // batch_step_execution — counters default to 0 so a fresh row is valid.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_step_execution" (
      "id" varchar(255) PRIMARY KEY,
      "job_execution_id" varchar(255) NOT NULL,
      "step_name" varchar(255) NOT NULL,
      "status" varchar(20) NOT NULL,
      "read_count" int NOT NULL DEFAULT 0,
      "write_count" int NOT NULL DEFAULT 0,
      "skip_count" int NOT NULL DEFAULT 0,
      "rollback_count" int NOT NULL DEFAULT 0,
      "commit_count" int NOT NULL DEFAULT 0
    );`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "batch_step_execution_job_execution_id_index" ON "batch_step_execution" ("job_execution_id");`);

    // batch_job_execution_context — JSON payload + version for optimistic concurrency.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_job_execution_context" (
      "job_execution_id" varchar(255) PRIMARY KEY,
      "data" text NOT NULL,
      "version" int NOT NULL DEFAULT 0
    );`);

    // batch_step_execution_context — same shape as job context, scoped to a step.
    this.addSql(`CREATE TABLE IF NOT EXISTS "batch_step_execution_context" (
      "step_execution_id" varchar(255) PRIMARY KEY,
      "data" text NOT NULL,
      "version" int NOT NULL DEFAULT 0
    );`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "batch_step_execution_context";`);
    this.addSql(`DROP TABLE IF EXISTS "batch_job_execution_context";`);
    this.addSql(`DROP TABLE IF EXISTS "batch_step_execution";`);
    this.addSql(`DROP TABLE IF EXISTS "batch_job_execution_params";`);
    this.addSql(`DROP TABLE IF EXISTS "batch_job_execution";`);
    this.addSql(`DROP TABLE IF EXISTS "batch_job_instance";`);
  }
}
