import { Entity, Property, PrimaryKey, Unique, Index } from '@mikro-orm/core';

/**
 * Spring Batch BATCH_JOB_INSTANCE equivalent.
 *
 * One row per logical job instance. Uniqueness is enforced on
 * (jobName, jobKey) so that the same canonical key resolves to the
 * same instance across restarts.
 */
@Entity({ tableName: 'batch_job_instance' })
@Unique({ properties: ['jobName', 'jobKey'] })
export class JobInstanceEntity {
  @PrimaryKey()
  id!: string;

  @Property()
  jobName!: string;

  @Property()
  jobKey!: string;

  @Property()
  createdAt: Date = new Date();
}

/**
 * Spring Batch BATCH_JOB_EXECUTION equivalent.
 *
 * One row per job run. `status` is the stringified JobStatus enum.
 * `jobInstanceId` is a logical FK (no DB-level FK constraint to keep
 * the meta-schema decoupled from the in-memory model).
 */
@Entity({ tableName: 'batch_job_execution' })
export class JobExecutionEntity {
  @PrimaryKey()
  id!: string;

  @Index()
  @Property()
  jobInstanceId!: string;

  @Property()
  status!: string; // JobStatus enum as string

  @Property({ nullable: true })
  startTime: Date | null = null;

  @Property({ nullable: true })
  endTime: Date | null = null;

  @Property({ default: '' })
  exitCode!: string;

  @Property({ default: '' })
  exitMessage!: string;
}

/**
 * Spring Batch BATCH_JOB_EXECUTION_PARAMS equivalent.
 *
 * Composite key (jobExecutionId, paramName). The four value columns
 * are mutually exclusive: exactly one is non-null, dictated by
 * `paramType`. `longValue` is serialized as a string for bigint
 * safety across JavaScript's 53-bit number boundary.
 */
@Entity({ tableName: 'batch_job_execution_params' })
export class JobExecutionParamsEntity {
  @PrimaryKey()
  jobExecutionId!: string;

  @PrimaryKey()
  paramName!: string;

  @Property()
  paramType!: 'STRING' | 'DATE' | 'LONG' | 'DOUBLE';

  @Property({ nullable: true })
  stringValue?: string;

  @Property({ nullable: true })
  dateValue?: Date;

  @Property({ nullable: true, type: 'bigint' })
  longValue?: string; // serialize as string for bigint safety

  @Property({ nullable: true, type: 'double' })
  doubleValue?: number;
}

/**
 * Spring Batch BATCH_STEP_EXECUTION equivalent.
 *
 * One row per step run. Counter columns default to 0 so the entity
 * can be persisted immediately upon creation, before any items are
 * processed.
 */
@Entity({ tableName: 'batch_step_execution' })
export class StepExecutionEntity {
  @PrimaryKey()
  id!: string;

  @Index()
  @Property()
  jobExecutionId!: string;

  @Property()
  stepName!: string;

  @Property()
  status!: string; // StepStatus enum as string

  @Property({ default: 0 })
  readCount!: number;

  @Property({ default: 0 })
  writeCount!: number;

  @Property({ default: 0 })
  skipCount!: number;

  @Property({ default: 0 })
  rollbackCount!: number;

  @Property({ default: 0 })
  commitCount!: number;

  @Property({ default: '' })
  exitCode!: string;

  @Property({ default: '' })
  exitMessage!: string;
}

/**
 * Spring Batch BATCH_JOB_EXECUTION_CONTEXT equivalent.
 *
 * `data` is a JSON-serialized ExecutionContext payload. `version`
 * guards against lost updates during concurrent writers.
 */
@Entity({ tableName: 'batch_job_execution_context' })
export class JobExecutionContextEntity {
  @PrimaryKey()
  jobExecutionId!: string;

  @Property({ type: 'text' })
  data!: string; // JSON-serialized JsonValue

  @Property({ default: 0 })
  version!: number;
}

/**
 * Spring Batch BATCH_STEP_EXECUTION_CONTEXT equivalent.
 *
 * Mirrors the job-level context table but scoped to a single step
 * execution. The Metis/ORACLE decision was to drop
 * BATCH_STEP_EXECUTION_PARAMS — step parameters are derivable from
 * job params + step context — so this table has no params sibling.
 */
@Entity({ tableName: 'batch_step_execution_context' })
export class StepExecutionContextEntity {
  @PrimaryKey()
  stepExecutionId!: string;

  @Property({ type: 'text' })
  data!: string;

  @Property({ default: 0 })
  version!: number;
}
