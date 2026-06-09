import {
  pgTable,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const batchJobInstance = pgTable(
  'batch_job_instance',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobName: varchar('job_name', { length: 255 }).notNull(),
    jobKey: varchar('job_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('batch_job_instance_job_name_job_key_unique').on(
      t.jobName,
      t.jobKey,
    ),
  ],
);

export const batchJobExecution = pgTable(
  'batch_job_execution',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobInstanceId: varchar('job_instance_id', { length: 255 }).notNull(),
    status: varchar({ length: 20 }).notNull(),
    startTime: timestamp('start_time', { withTimezone: true, mode: 'date' }),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'date' }),
    exitCode: varchar('exit_code', { length: 255 }).notNull().default(''),
    exitMessage: text('exit_message').notNull().default(''),
    params: text().notNull().default('{}'),
  },
  (t) => [
    index('batch_job_execution_job_instance_id_index').on(t.jobInstanceId),
  ],
);

export const batchStepExecution = pgTable(
  'batch_step_execution',
  {
    id: varchar({ length: 255 }).primaryKey(),
    jobExecutionId: varchar('job_execution_id', { length: 255 }).notNull(),
    stepName: varchar('step_name', { length: 255 }).notNull(),
    status: varchar({ length: 20 }).notNull(),
    readCount: integer('read_count').notNull().default(0),
    writeCount: integer('write_count').notNull().default(0),
    skipCount: integer('skip_count').notNull().default(0),
    rollbackCount: integer('rollback_count').notNull().default(0),
    commitCount: integer('commit_count').notNull().default(0),
    exitCode: varchar('exit_code', { length: 255 }).notNull().default(''),
    exitMessage: text('exit_message').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('batch_step_execution_job_execution_id_index').on(t.jobExecutionId),
  ],
);

export const batchJobExecutionContext = pgTable(
  'batch_job_execution_context',
  {
    jobExecutionId: varchar('job_execution_id', { length: 255 }).primaryKey(),
    data: text().notNull(),
    version: integer().notNull().default(0),
  },
);

export const batchStepExecutionContext = pgTable(
  'batch_step_execution_context',
  {
    stepExecutionId: varchar('step_execution_id', { length: 255 }).primaryKey(),
    data: text().notNull(),
    version: integer().notNull().default(0),
  },
);
