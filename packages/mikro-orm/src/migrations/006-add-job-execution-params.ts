import { Migration } from '@mikro-orm/migrations';

/**
 * Adds a `params` text column to `batch_job_execution` so that
 * `getJobExecution` can return the original `JobParameters` snapshot.
 * The column stores a JSON-serialized string (default `{}`).
 */
export class AddJobExecutionParams006 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE "batch_job_execution" ADD COLUMN IF NOT EXISTS "params" text NOT NULL DEFAULT '{}';`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "batch_job_execution" DROP COLUMN IF EXISTS "params";`);
  }
}
