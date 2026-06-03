import { Migration } from '@mikro-orm/migrations';

export class AddStepExecutionExitFields003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE "batch_step_execution" ADD COLUMN "exit_code" varchar(255) NOT NULL DEFAULT '';`);
    this.addSql(`ALTER TABLE "batch_step_execution" ADD COLUMN "exit_message" text NOT NULL DEFAULT '';`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "batch_step_execution" DROP COLUMN "exit_code";`);
    this.addSql(`ALTER TABLE "batch_step_execution" DROP COLUMN "exit_message";`);
  }
}
