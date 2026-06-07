import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  type EntityTarget,
} from 'typeorm';
import {
  JobRepository,
  JobExecutionAlreadyRunningError,
  assertJsonSerializable,
  serializeContext,
  deserializeContext,
  JobStatus,
  StepStatus,
} from '@nest-batch/core';
import type {
  JobInstance,
  JobExecution,
  JobExecutionPatch,
  JobParameters,
  StepExecution,
  StepExecutionPatch,
  ExecutionContext,
  ExecutionScope,
} from '@nest-batch/core';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from '../entities/job-meta.entities';

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

function mapJobInstance(e: JobInstanceEntity): JobInstance {
  return {
    id: e.id,
    jobName: e.jobName,
    jobKey: e.jobKey,
    createdAt: e.createdAt,
  };
}

function mapJobExecution(e: JobExecutionEntity): JobExecution {
  let params: JobParameters = {};
  if (e.params && e.params.length > 0) {
    try {
      params = deserializeContext<JobParameters>(e.params);
    } catch {
      params = {};
    }
  }
  return {
    id: e.id,
    jobInstanceId: e.jobInstanceId,
    status: e.status as JobStatus,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    exitCode: e.exitCode,
    exitMessage: e.exitMessage,
    params,
  };
}

function mapStepExecution(e: StepExecutionEntity): StepExecution {
  return {
    id: e.id,
    jobExecutionId: e.jobExecutionId,
    stepName: e.stepName,
    status: e.status as StepStatus,
    readCount: e.readCount,
    writeCount: e.writeCount,
    skipCount: e.skipCount,
    rollbackCount: e.rollbackCount,
    commitCount: e.commitCount,
    startTime: null,
    endTime: null,
    exitCode: e.exitCode,
    exitMessage: e.exitMessage,
  };
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = deepClone((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

/**
 * TypeORM 1.0.0-backed `JobRepository`.
 *
 * All state lives in the six batch meta tables owned by this package.
 * The contract guarantees:
 *   - `getOrCreateJobInstance` is race-safe via the (jobName, jobKey)
 *     unique index — concurrent inserts collapse to one row, the
 *     losers receive the winner's id.
 *   - `createExecutionAtomic` runs inside a single transaction that
 *     (a) idempotently upserts the instance row, (b) acquires a row
 *     lock with `SELECT ... FOR UPDATE SKIP LOCKED` (or
 *     `pessimistic_write` + `skip_locked` for drivers that prefer
 *     that API), and (c) rejects with
 *     `JobExecutionAlreadyRunningError` if a STARTING/STARTED
 *     execution already exists.
 *   - `saveExecutionContext` deep-clones the data and auto-increments
 *     the version counter when `version` is omitted.
 *   - `findLatestStepExecution` orders by `created_at` (insertion
 *     timestamp) descending and returns the most recently created
 *     step execution for `(jobExecutionId, stepName)`, or `null` if
 *     no row matches.
 */
@Injectable()
export class TypeOrmJobRepository extends JobRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private em(): EntityManager {
    return this.dataSource.manager;
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    // Fast path: existing row.
    const existing = await this.em().findOne(JobInstanceEntity, {
      where: { jobName: name, jobKey },
    });
    if (existing) return mapJobInstance(existing);

    // Slow path: try to insert; on unique-constraint violation, the
    // row was created by a concurrent caller — read it back.
    const inst = new JobInstanceEntity();
    inst.id = randomUUID();
    inst.jobName = name;
    inst.jobKey = jobKey;
    inst.createdAt = new Date();
    try {
      await this.em().save(inst);
      return mapJobInstance(inst);
    } catch {
      const winner = await this.em().findOne(JobInstanceEntity, {
        where: { jobName: name, jobKey },
      });
      if (winner) return mapJobInstance(winner);
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
  }

  async createJobExecution(
    jobInstanceId: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    const exec = new JobExecutionEntity();
    exec.id = randomUUID();
    exec.jobInstanceId = jobInstanceId;
    exec.status = JobStatus.STARTING;
    exec.startTime = null;
    exec.endTime = null;
    exec.exitCode = '';
    exec.exitMessage = '';
    exec.params = serializeContext(deepClone(params));
    await this.em().save(exec);
    return mapJobExecution(exec);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    // Run the entire check-then-create sequence inside a single
    // transaction. The instance row is locked with `FOR UPDATE SKIP
    // LOCKED` semantics, so a concurrent launch for the same
    // (name, jobKey) sees 0 rows and aborts cleanly. The lock is
    // held until the transaction commits, which is when control
    // returns to the caller; the executor itself runs OUTSIDE this
    // lock.
    return this.dataSource.transaction(async (em) => {
      // 1. Ensure the JobInstance row exists. Try to insert; on
      // unique-constraint violation, the row is already there.
      const inst = new JobInstanceEntity();
      inst.id = randomUUID();
      inst.jobName = name;
      inst.jobKey = jobKey;
      inst.createdAt = new Date();
      // 1. Ensure the JobInstance row exists. Use orIgnore so a
      // unique-constraint violation (row already inserted by a
      // concurrent caller) does not abort the surrounding PG
      // transaction — PG marks a transaction aborted on the first
      // statement failure, which would break the FOR UPDATE SKIP
      // LOCKED query below. SQLite also accepts orIgnore and emits
      // INSERT OR IGNORE.
      await em
        .createQueryBuilder()
        .insert()
        .into(JobInstanceEntity)
        .values({
          id: inst.id,
          jobName: inst.jobName,
          jobKey: inst.jobKey,
          createdAt: inst.createdAt,
        })
        .orIgnore()
        .execute();

      // 2. Lock the instance row. SKIP LOCKED means: if another
      // concurrent launch already holds the lock, this returns 0
      // rows and we treat that as "another launch in progress".
      // SQLite (better-sqlite3) does not support pessimistic_write
      // locking via TypeORM, so we fall back to raw SQL for SQLite
      // and use the ORM abstraction for everything else.
      let locked: JobInstanceEntity | null = null;
      if (this.dataSource.options.type === 'better-sqlite3') {
        const raw = await em.query(
          `SELECT id, job_name AS jobName, job_key AS jobKey, created_at AS createdAt
           FROM batch_job_instance
           WHERE job_name = ? AND job_key = ?
           LIMIT 1`,
          [name, jobKey],
        );
        locked = raw[0] ? (em.create(JobInstanceEntity, raw[0]) as JobInstanceEntity) : null;
      } else {
        locked = await em.findOne(JobInstanceEntity, {
          where: { jobName: name, jobKey },
          lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
        });
      }
      if (!locked) {
        throw new JobExecutionAlreadyRunningError(name);
      }

      // 3. Under the lock, verify no running execution.
      const running = await em.findOne(JobExecutionEntity, {
        where: {
          jobInstanceId: locked.id,
          status: In([JobStatus.STARTING, JobStatus.STARTED]),
        },
      });
      if (running) {
        throw new JobExecutionAlreadyRunningError(running.id);
      }

      // 4. Create the new execution row. Because we hold the row
      // lock on JobInstance, no other launch can create a competing
      // execution for the same instance until this TX commits.
      const exec = new JobExecutionEntity();
      exec.id = randomUUID();
      exec.jobInstanceId = locked.id;
      exec.status = JobStatus.STARTING;
      exec.startTime = null;
      exec.endTime = null;
      exec.exitCode = '';
      exec.exitMessage = '';
      exec.params = serializeContext(deepClone(params));
      await em.save(exec);
      return mapJobExecution(exec);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const e = await this.em().findOne(JobExecutionEntity, { where: { id: executionId } });
    if (!e) throw new Error(`JobExecution not found: ${executionId}`);
    if (patch.status !== undefined) e.status = patch.status;
    if (patch.startTime !== undefined) e.startTime = patch.startTime;
    if (patch.endTime !== undefined) e.endTime = patch.endTime;
    if (patch.exitCode !== undefined) e.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) e.exitMessage = patch.exitMessage;
    await this.em().save(e);
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const e = await this.em().findOne(JobExecutionEntity, { where: { id: executionId } });
    return e ? mapJobExecution(e) : null;
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const e = await this.em().findOne(JobExecutionEntity, {
      where: {
        jobInstanceId,
        status: In([JobStatus.STARTING, JobStatus.STARTED]),
      },
      order: { startTime: 'DESC' },
    });
    return e ? mapJobExecution(e) : null;
  }

  async createStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution> {
    const step = new StepExecutionEntity();
    step.id = randomUUID();
    step.jobExecutionId = jobExecutionId;
    step.stepName = stepName;
    step.status = StepStatus.STARTING;
    step.readCount = 0;
    step.writeCount = 0;
    step.skipCount = 0;
    step.rollbackCount = 0;
    step.commitCount = 0;
    step.exitCode = '';
    step.exitMessage = '';
    step.createdAt = new Date();
    await this.em().save(step);
    return mapStepExecution(step);
  }

  async updateStepExecution(
    stepExecutionId: string,
    patch: StepExecutionPatch,
  ): Promise<void> {
    const s = await this.em().findOne(StepExecutionEntity, {
      where: { id: stepExecutionId },
    });
    if (!s) throw new Error(`StepExecution not found: ${stepExecutionId}`);
    if (patch.status !== undefined) s.status = patch.status;
    if (patch.readCount !== undefined) s.readCount = patch.readCount;
    if (patch.writeCount !== undefined) s.writeCount = patch.writeCount;
    if (patch.skipCount !== undefined) s.skipCount = patch.skipCount;
    if (patch.rollbackCount !== undefined) s.rollbackCount = patch.rollbackCount;
    if (patch.commitCount !== undefined) s.commitCount = patch.commitCount;
    if (patch.exitCode !== undefined) s.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) s.exitMessage = patch.exitMessage;
    await this.em().save(s);
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const s = await this.em().findOne(StepExecutionEntity, {
      where: { id: stepExecutionId },
    });
    return s ? mapStepExecution(s) : null;
  }

  /**
   * Find the most recently created step execution for the given
   * `(jobExecutionId, stepName)` pair, or `null` when none exists.
   * Insertion order is determined by the `created_at` column (a
   * `timestamptz` defaulting to `CURRENT_TIMESTAMP`); the primary
   * key is a v4 UUID which is random, so a `id DESC` order would
   * not correspond to insertion time. The `created_at DESC, id DESC`
   * secondary order keeps the result stable when two rows share the
   * same `CURRENT_TIMESTAMP` resolution (same millisecond in tests).
   */
  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = await this.em()
      .createQueryBuilder(StepExecutionEntity, 's')
      .where('s.job_execution_id = :jobExecutionId', { jobExecutionId })
      .andWhere('s.step_name = :stepName', { stepName })
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .limit(1)
      .getMany();
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const e = await this.em().findOne(JobExecutionContextEntity, {
        where: { jobExecutionId: key.slice(5) },
      });
      if (e) {
        return {
          data: e.data.length > 0 ? deserializeContext(e.data) : null,
          version: e.version,
        };
      }
    } else {
      const e = await this.em().findOne(StepExecutionContextEntity, {
        where: { stepExecutionId: key.slice(6) },
      });
      if (e) {
        return {
          data: e.data.length > 0 ? deserializeContext(e.data) : null,
          version: e.version,
        };
      }
    }
    return { data: null, version: 0 };
  }

  async saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void> {
    assertJsonSerializable(ctx.data);
    const key = scopeKey(scope);
    const serialized = serializeContext(deepClone(ctx.data));
    if (key.startsWith('job::')) {
      const jobExecutionId = key.slice(5);
      const existing = await this.em().findOne(JobExecutionContextEntity, {
        where: { jobExecutionId },
      });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        existing.data = serialized;
        existing.version = nextVersion;
        await this.em().save(existing);
      } else {
        const e = new JobExecutionContextEntity();
        e.jobExecutionId = jobExecutionId;
        e.data = serialized;
        e.version = nextVersion;
        await this.em().save(e);
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.em().findOne(StepExecutionContextEntity, {
        where: { stepExecutionId },
      });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        existing.data = serialized;
        existing.version = nextVersion;
        await this.em().save(existing);
      } else {
        const e = new StepExecutionContextEntity();
        e.stepExecutionId = stepExecutionId;
        e.data = serialized;
        e.version = nextVersion;
        await this.em().save(e);
      }
    }
  }
}

/**
 * Re-exports the entity class array as a TypeORM-typed list. We
 * intentionally keep the function form so callers can pass the
 * entities to `DataSource#entityMetadatas` or as the `entities:`
 * option in a DataSource config.
 */
export function batchMetaEntities(): EntityTarget<unknown>[] {
  return [
    JobInstanceEntity,
    JobExecutionEntity,
    StepExecutionEntity,
    JobExecutionContextEntity,
    StepExecutionContextEntity,
  ];
}
