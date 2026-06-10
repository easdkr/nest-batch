import { Entity, Property, PrimaryKey, Unique, Index } from '@mikro-orm/core';

/**
 * Spring Batch BATCH_JOB_INSTANCE equivalent (MySQL 8.x).
 *
 * One row per logical job instance. Uniqueness is enforced on
 * (jobName, jobKey) so that the same canonical key resolves to
 * the same instance across restarts.
 *
 * Owned by `@nest-batch/mysql` in 0.2.0. The class is the
 * MySQL-flavored sibling of the Postgres `JobInstanceEntity` in
 * `@nest-batch/postgresql/src/job-meta-entities.postgres.ts` —
 * the shape is byte-identical (Spring Batch meta-schema) and the
 * column types resolve to the MySQL equivalents of their Postgres
 * counterparts under the `@mikro-orm/mysql` driver.
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
 * Spring Batch BATCH_JOB_EXECUTION equivalent (MySQL 8.x).
 *
 * One row per job run. `status` is the stringified JobStatus enum.
 * `jobInstanceId` is a logical FK (no DB-level FK constraint to
 * keep the meta-schema decoupled from the in-memory model).
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

  @Property({ type: 'text', default: '{}' })
  params!: string;
}

/**
 * Spring Batch BATCH_STEP_EXECUTION equivalent (MySQL 8.x).
 *
 * One row per step run. Counter columns default to 0 so the
 * entity can be persisted immediately upon creation, before any
 * items are processed.
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

  @Property()
  createdAt: Date = new Date();
}

/**
 * Spring Batch BATCH_JOB_EXECUTION_CONTEXT equivalent (MySQL 8.x).
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
 * Spring Batch BATCH_STEP_EXECUTION_CONTEXT equivalent (MySQL 8.x).
 *
 * Mirrors the job-level context table but scoped to a single
 * step execution. The 0.2.0 decision was to drop
 * BATCH_STEP_EXECUTION_PARAMS — step parameters are derivable
 * from the parent job execution params plus the step execution
 * context — so this table has no params sibling.
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

/**
 * The 5 batch meta-entities owned by `@nest-batch/mysql`.
 *
 * Apps that already configure their own MikroORM connection
 * (`MikroOrmModule.forRoot()` from `@mikro-orm/nestjs`) should
 * spread this list into the host's `entities` array so the
 * batch meta tables are wired in. The corresponding MySQL DDL
 * lives at `migrations/1700000000001-CreateBatchMetaMysql.ts`
 * (the TypeORM 1.0.0 migration class bundled in this package).
 *
 * The 5-table `BATCH_META_ENTITIES` constant that
 * `@nest-batch/mikro-orm` shipped in 0.1.x moved to the
 * driver-sibling packages in 0.2.0; the
 * `batch_job_execution_params` table was intentionally dropped
 * during the move (its content is fully derivable from the
 * parent job execution params + step execution context).
 */
export const BATCH_META_ENTITIES = [
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
] as const;
