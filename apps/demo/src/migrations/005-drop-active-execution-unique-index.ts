import { Migration } from '@mikro-orm/migrations';

export class DropActiveExecutionUniqueIndex005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "batch_job_execution_active_idx";`);
  }

  override async down(): Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX "batch_job_execution_active_idx"
      ON "batch_job_execution" ("job_instance_id")
      WHERE "status" IN ('STARTING', 'STARTED');
    `);
  }
}
