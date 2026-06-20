import {
  mysqlTable,
  varchar,
  text,
  int,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core';

/**
 * MySQL-flavored Drizzle schema for the six batch
 * batch meta tables.
 *
 * The column names match the PostgreSQL `pgTable` schema in
 * `@nest-batch/drizzle` exactly (snake_case), so the same entity
 * mapping logic and SQL contract tests can run against either driver.
 * The dialect-specific difference is the `mysqlTable` factory and
 * the `timestamp` column type (no `timestamptz` in MySQL — `DATETIME`
 * is the portable choice).
 */
export const batchJobInstance = mysqlTable(
  'batch_job_instance',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobName: varchar('job_name', { length: 255 }).notNull(),
    jobKey: varchar('job_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('batch_job_instance_job_name_job_key_unique').on(
      t.jobName,
      t.jobKey,
    ),
  ],
);

export const batchJobExecution = mysqlTable(
  'batch_job_execution',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobInstanceId: varchar('job_instance_id', { length: 255 }).notNull(),
    status: varchar({ length: 20 }).notNull(),
    startTime: timestamp('start_time', { mode: 'date' }),
    endTime: timestamp('end_time', { mode: 'date' }),
    exitCode: varchar('exit_code', { length: 255 }).notNull().default(''),
    exitMessage: text('exit_message').notNull().default(''),
    params: text().notNull().default('{}'),
  },
  (t) => [
    index('batch_job_execution_job_instance_id_index').on(t.jobInstanceId),
  ],
);

export const batchStepExecution = mysqlTable(
  'batch_step_execution',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobExecutionId: varchar('job_execution_id', { length: 255 }).notNull(),
    stepName: varchar('step_name', { length: 255 }).notNull(),
    status: varchar({ length: 20 }).notNull(),
    readCount: int('read_count').notNull().default(0),
    writeCount: int('write_count').notNull().default(0),
    skipCount: int('skip_count').notNull().default(0),
    rollbackCount: int('rollback_count').notNull().default(0),
    commitCount: int('commit_count').notNull().default(0),
    exitCode: varchar('exit_code', { length: 255 }).notNull().default(''),
    exitMessage: text('exit_message').notNull().default(''),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('batch_step_execution_job_execution_id_index').on(t.jobExecutionId),
  ],
);

export const batchJobExecutionContext = mysqlTable(
  'batch_job_execution_context',
  {
    jobExecutionId: varchar('job_execution_id', { length: 255 }).primaryKey(),
    data: text().notNull(),
    version: int().notNull().default(0),
  },
);

export const batchStepExecutionContext = mysqlTable(
  'batch_step_execution_context',
  {
    stepExecutionId: varchar('step_execution_id', { length: 255 }).primaryKey(),
    data: text().notNull(),
    version: int().notNull().default(0),
  },
);
