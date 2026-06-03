import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * Spring Batch BATCH_JOB_INSTANCE equivalent.
 *
 * One row per logical job instance. Uniqueness is enforced on
 * (jobName, jobKey) so that the same canonical key resolves to the
 * same instance across restarts. The composite unique index is
 * declared on the entity and is also reified in the bundled
 * migration under the same name.
 */
@Entity('batch_job_instance')
@Index('batch_job_instance_job_name_job_key_unique', ['jobName', 'jobKey'], { unique: true })
export class JobInstanceEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ name: 'job_name', type: 'varchar', length: 255 })
  jobName!: string;

  @Column({ name: 'job_key', type: 'varchar', length: 255 })
  jobKey!: string;

  @Column({
    name: 'created_at',
    // `datetime` is portable across PostgreSQL and SQLite (the test
    // driver). The bundled migration uses timestamptz on
    // PostgreSQL by hand; SQLite loses the timezone qualifier,
    // which is acceptable for a creation-time stamp that is never
    // compared with sub-second precision in queries.
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date = new Date();
}

/**
 * Spring Batch BATCH_JOB_EXECUTION equivalent.
 *
 * One row per job run. `status` is the stringified JobStatus enum
 * (kept as a plain varchar — TypeORM enum support varies across
 * drivers and v1.0.0 dropped a few columns we don't need). The
 * `jobInstanceId` column is indexed because every contract lookup
 * ("is this instance running?") scans by it.
 */
@Entity('batch_job_execution')
@Index('batch_job_execution_job_instance_id_index', ['jobInstanceId'])
export class JobExecutionEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ name: 'job_instance_id', type: 'varchar', length: 255 })
  jobInstanceId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ name: 'start_time', type: 'datetime', nullable: true })
  startTime: Date | null = null;

  @Column({ name: 'end_time', type: 'datetime', nullable: true })
  endTime: Date | null = null;

  @Column({ name: 'exit_code', type: 'varchar', length: 255, default: '' })
  exitCode!: string;

  @Column({ name: 'exit_message', type: 'text', default: '' })
  exitMessage!: string;

  /**
   * JSON-serialized `JobParameters` snapshot. Stored as `text` (not
   * native `jsonb`) so the adapter works uniformly across SQLite (used
   * in unit tests) and PostgreSQL/MySQL — the column is always a
   * serialized payload, never queried by the ORM.
   */
  @Column({ name: 'params', type: 'text', default: '{}' })
  params!: string;
}

/**
 * Spring Batch BATCH_STEP_EXECUTION equivalent.
 *
 * One row per step run. Counters default to 0 so the entity can
 * be persisted immediately upon creation, before any items are
 * processed. `createdAt` is stamped on insert and used by
 * `findLatestStepExecution` to resolve the most recently created
 * step for a given `(jobExecutionId, stepName)` pair — a v4 UUID
 * primary key does not preserve insertion order, so an explicit
 * monotonic column is required.
 */
@Entity('batch_step_execution')
@Index('batch_step_execution_job_execution_id_index', ['jobExecutionId'])
export class StepExecutionEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ name: 'job_execution_id', type: 'varchar', length: 255 })
  jobExecutionId!: string;

  @Column({ name: 'step_name', type: 'varchar', length: 255 })
  stepName!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ name: 'read_count', type: 'int', default: 0 })
  readCount!: number;

  @Column({ name: 'write_count', type: 'int', default: 0 })
  writeCount!: number;

  @Column({ name: 'skip_count', type: 'int', default: 0 })
  skipCount!: number;

  @Column({ name: 'rollback_count', type: 'int', default: 0 })
  rollbackCount!: number;

  @Column({ name: 'commit_count', type: 'int', default: 0 })
  commitCount!: number;

  @Column({ name: 'exit_code', type: 'varchar', length: 255, default: '' })
  exitCode!: string;

  @Column({ name: 'exit_message', type: 'text', default: '' })
  exitMessage!: string;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date = new Date();
}

/**
 * Spring Batch BATCH_JOB_EXECUTION_CONTEXT equivalent.
 *
 * `data` is a JSON-serialized ExecutionContext payload. `version`
 * guards against lost updates during concurrent writers.
 */
@Entity('batch_job_execution_context')
export class JobExecutionContextEntity {
  @PrimaryColumn({ name: 'job_execution_id', type: 'varchar', length: 255 })
  jobExecutionId!: string;

  @Column({ type: 'text' })
  data!: string;

  @Column({ type: 'int', default: 0 })
  version!: number;
}

/**
 * Spring Batch BATCH_STEP_EXECUTION_CONTEXT equivalent.
 *
 * Mirrors the job-level context table but scoped to a single
 * step execution. There is intentionally no params sibling table
 * for steps — step parameters are derivable from the parent job
 * execution params + the step execution context.
 */
@Entity('batch_step_execution_context')
export class StepExecutionContextEntity {
  @PrimaryColumn({ name: 'step_execution_id', type: 'varchar', length: 255 })
  stepExecutionId!: string;

  @Column({ type: 'text' })
  data!: string;

  @Column({ type: 'int', default: 0 })
  version!: number;
}

/**
 * All batch meta entities owned by this package. Hand to
 * `DataSource#entityMetadatas` (or `entities:`) so TypeORM
 * discovers them through the standard decorator scan.
 */
export const BATCH_META_ENTITIES = [
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
] as const;
