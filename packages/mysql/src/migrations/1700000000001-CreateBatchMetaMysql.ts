import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the six batch meta-tables in MySQL 8.x
 * (the MySQL driver shells: MikroORM MySQL, TypeORM MySQL, Drizzle
 * MySQL, Prisma MySQL).
 *
 * Column shapes are MySQL-portable: `VARCHAR(255)` for short strings,
 * `TEXT` for long ones, `DATETIME(6)` for timestamps, `INT` for
 * counters. The six tables are the same shape as the PostgreSQL
 * migration in `@nest-batch/typeorm`, modulo the column types —
 * `VARCHAR(255) PRIMARY KEY` (no inline UNIQUE) on `job_instance`,
 * and `DATETIME(6)` instead of `TIMESTAMPTZ(6)`.
 *
 * Reverse-dependency order on `down()`: children first.
 */
export class CreateBatchMetaMysql1700000000001 implements MigrationInterface {
  name = 'CreateBatchMetaMysql1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // batch_job_instance — root of the meta-graph; (job_name, job_key) is unique.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_job_instance\` (
        \`id\` VARCHAR(255) NOT NULL,
        \`job_name\` VARCHAR(255) NOT NULL,
        \`job_key\` VARCHAR(255) NOT NULL,
        \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`batch_job_instance_job_name_job_key_unique\` (\`job_name\`, \`job_key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // batch_job_execution — one row per job run; indexed by job_instance_id.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_job_execution\` (
        \`id\` VARCHAR(255) NOT NULL,
        \`job_instance_id\` VARCHAR(255) NOT NULL,
        \`status\` VARCHAR(20) NOT NULL,
        \`start_time\` DATETIME(6) NULL,
        \`end_time\` DATETIME(6) NULL,
        \`exit_code\` VARCHAR(255) NOT NULL DEFAULT '',
        \`exit_message\` TEXT NOT NULL,
        \`params\` TEXT NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`batch_job_execution_job_instance_id_index\` (\`job_instance_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // batch_job_execution_params — composite PK; long_value is varchar for bigint safety.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_job_execution_params\` (
        \`job_execution_id\` VARCHAR(255) NOT NULL,
        \`param_name\` VARCHAR(255) NOT NULL,
        \`param_type\` VARCHAR(20) NOT NULL,
        \`string_value\` TEXT NULL,
        \`date_value\` DATETIME(6) NULL,
        \`long_value\` VARCHAR(255) NULL,
        \`double_value\` DOUBLE NULL,
        PRIMARY KEY (\`job_execution_id\`, \`param_name\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // batch_step_execution — counters default to 0; created_at powers findLatestStepExecution.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_step_execution\` (
        \`id\` VARCHAR(255) NOT NULL,
        \`job_execution_id\` VARCHAR(255) NOT NULL,
        \`step_name\` VARCHAR(255) NOT NULL,
        \`status\` VARCHAR(20) NOT NULL,
        \`read_count\` INT NOT NULL DEFAULT 0,
        \`write_count\` INT NOT NULL DEFAULT 0,
        \`skip_count\` INT NOT NULL DEFAULT 0,
        \`rollback_count\` INT NOT NULL DEFAULT 0,
        \`commit_count\` INT NOT NULL DEFAULT 0,
        \`exit_code\` VARCHAR(255) NOT NULL DEFAULT '',
        \`exit_message\` TEXT NOT NULL,
        \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        KEY \`batch_step_execution_job_execution_id_index\` (\`job_execution_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // batch_job_execution_context — JSON payload + version for optimistic concurrency.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_job_execution_context\` (
        \`job_execution_id\` VARCHAR(255) NOT NULL,
        \`data\` TEXT NOT NULL,
        \`version\` INT NOT NULL DEFAULT 0,
        PRIMARY KEY (\`job_execution_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // batch_step_execution_context — same shape, scoped to a step.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`batch_step_execution_context\` (
        \`step_execution_id\` VARCHAR(255) NOT NULL,
        \`data\` TEXT NOT NULL,
        \`version\` INT NOT NULL DEFAULT 0,
        PRIMARY KEY (\`step_execution_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse-dependency order: children first.
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_step_execution_context\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_job_execution_context\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_step_execution\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_job_execution_params\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_job_execution\``);
    await queryRunner.query(`DROP TABLE IF EXISTS \`batch_job_instance\``);
  }
}
