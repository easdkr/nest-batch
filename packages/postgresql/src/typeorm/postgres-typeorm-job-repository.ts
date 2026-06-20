import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
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
  JobInstanceFilter,
  JobExecutionFilter,
} from '@nest-batch/core';

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
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

interface JobInstanceRow {
  id: string;
  job_name: string;
  job_key: string;
  created_at: string | Date;
}

interface JobExecutionRow {
  id: string;
  job_instance_id: string;
  status: string;
  start_time: string | Date | null;
  end_time: string | Date | null;
  exit_code: string;
  exit_message: string;
  params: string;
}

interface StepExecutionRow {
  id: string;
  job_execution_id: string;
  step_name: string;
  status: string;
  read_count: number;
  write_count: number;
  skip_count: number;
  rollback_count: number;
  commit_count: number;
  exit_code: string;
  exit_message: string;
  created_at: string | Date;
}

interface ContextRow {
  data: string;
  version: number;
}

function mapJobInstance(r: JobInstanceRow): JobInstance {
  return {
    id: r.id,
    jobName: r.job_name,
    jobKey: r.job_key,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  };
}

function mapJobExecution(r: JobExecutionRow): JobExecution {
  let params: JobParameters = {};
  if (r.params && r.params.length > 0) {
    try {
      params = deserializeContext<JobParameters>(r.params);
    } catch {
      params = {};
    }
  }
  return {
    id: r.id,
    jobInstanceId: r.job_instance_id,
    status: r.status as JobStatus,
    startTime: r.start_time ? (r.start_time instanceof Date ? r.start_time : new Date(r.start_time)) : null,
    endTime: r.end_time ? (r.end_time instanceof Date ? r.end_time : new Date(r.end_time)) : null,
    exitCode: r.exit_code,
    exitMessage: r.exit_message,
    params,
  };
}

function mapStepExecution(r: StepExecutionRow): StepExecution {
  return {
    id: r.id,
    jobExecutionId: r.job_execution_id,
    stepName: r.step_name,
    status: r.status as StepStatus,
    readCount: r.read_count,
    writeCount: r.write_count,
    skipCount: r.skip_count,
    rollbackCount: r.rollback_count,
    commitCount: r.commit_count,
    startTime: null,
    endTime: null,
    exitCode: r.exit_code,
    exitMessage: r.exit_message,
  };
}

/**
 * Postgres-flavored `JobRepository` for the `@nest-batch/typeorm` slot.
 *
 * Mirrors the (refactored) `TypeOrmJobRepository` shape exactly:
 * raw SQL through `em.query(...)` against the 6-table Postgres meta
 * schema. Postgres 9.5+ supports `SELECT ... FOR UPDATE SKIP LOCKED`
 * natively. The repository is the durable source of truth for
 * execution state — see README §"DB-first semantics".
 *
 * SQL dialect differences from the MySQL shell
 * (`MysqlTypeOrmJobRepository`):
 *
 * - Identifier quoting: backticks `` ` `` → double-quotes `"`.
 *   Postgres also accepts unquoted lower-case identifiers, but
 *   double-quotes are the explicit form that round-trips through
 *   the Drizzle / Prisma carriers without surprises.
 * - Idempotent insert: `INSERT ... ON DUPLICATE KEY UPDATE id=id` →
 *   `INSERT ... ON CONFLICT (job_name, job_key) DO NOTHING`. The
 *   unique constraint on `(job_name, job_key)` (defined in the
 *   bundled `migrations/0001-create-batch-meta.sql`) is the
 *   conflict target.
 * - Time function: `NOW(6)` → `NOW()`. Postgres' `NOW()` returns
 *   `timestamptz` with microsecond precision natively; the
 *   `(6)` microsecond suffix is MySQL-specific.
 */
@Injectable()
export class PostgresTypeOrmJobRepository extends JobRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private em(): EntityManager {
    return this.dataSource.manager;
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const rows = await this.em().query<JobInstanceRow[]>(
      `SELECT id, job_name, job_key, created_at
       FROM "batch_job_instance"
       WHERE job_name = $1 AND job_key = $2
       LIMIT 1`,
      [name, jobKey],
    );
    if (rows.length > 0) return mapJobInstance(rows[0]!);

    const id = randomUUID();
    try {
      await this.em().query(
        `INSERT INTO "batch_job_instance" (id, job_name, job_key, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (job_name, job_key) DO NOTHING`,
        [id, name, jobKey],
      );
      const created = await this.em().query<JobInstanceRow[]>(
        `SELECT id, job_name, job_key, created_at
         FROM "batch_job_instance"
         WHERE job_name = $1 AND job_key = $2
         LIMIT 1`,
        [name, jobKey],
      );
      if (created.length === 0) {
        throw new Error(
          `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
        );
      }
      return mapJobInstance(created[0]!);
    } catch {
      const winner = await this.em().query<JobInstanceRow[]>(
        `SELECT id, job_name, job_key, created_at
         FROM "batch_job_instance"
         WHERE job_name = $1 AND job_key = $2
         LIMIT 1`,
        [name, jobKey],
      );
      if (winner.length > 0) return mapJobInstance(winner[0]!);
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
  }

  override async getJobInstance(jobInstanceId: string): Promise<JobInstance | null> {
    const rows = await this.em().query<JobInstanceRow[]>(
      `SELECT id, job_name, job_key, created_at
       FROM "batch_job_instance"
       WHERE id = $1
       LIMIT 1`,
      [jobInstanceId],
    );
    return rows.length > 0 ? mapJobInstance(rows[0]!) : null;
  }

  override async findJobInstances(
    filter: JobInstanceFilter = {},
  ): Promise<JobInstance[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.jobName !== undefined) {
      params.push(filter.jobName);
      where.push(`job_name = $${params.length}`);
    }
    if (filter.jobKey !== undefined) {
      params.push(filter.jobKey);
      where.push(`job_key = $${params.length}`);
    }

    const rows = await this.em().query<JobInstanceRow[]>(
      `SELECT id, job_name, job_key, created_at
       FROM "batch_job_instance"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(mapJobInstance);
  }

  async createJobExecution(
    jobInstanceId: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    const id = randomUUID();
    await this.em().query(
      `INSERT INTO "batch_job_execution"
        (id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params)
       VALUES ($1, $2, 'STARTING', NULL, NULL, '', '', $3)`,
      [id, jobInstanceId, serializeContext(deepClone(params))],
    );
    const rows = await this.em().query<JobExecutionRow[]>(
      `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
       FROM "batch_job_execution"
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (rows.length === 0) {
      throw new Error(`JobExecution not found immediately after insert: ${id}`);
    }
    return mapJobExecution(rows[0]!);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.dataSource.transaction(async (em) => {
      // 1. Idempotently insert the JobInstance row.
      const instId = randomUUID();
      await em.query(
        `INSERT INTO "batch_job_instance" (id, job_name, job_key, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (job_name, job_key) DO NOTHING`,
        [instId, name, jobKey],
      );

      // 2. Lock the instance row. Postgres 9.5+ supports
      // `SELECT ... FOR UPDATE SKIP LOCKED`.
      const locked = await em.query<JobInstanceRow[]>(
        `SELECT id, job_name, job_key, created_at
         FROM "batch_job_instance"
         WHERE job_name = $1 AND job_key = $2
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [name, jobKey],
      );
      if (!locked || locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      // 3. Under the lock, verify no running execution.
      const running = await em.query<JobExecutionRow[]>(
        `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
         FROM "batch_job_execution"
         WHERE job_instance_id = $1 AND status IN ('STARTING', 'STARTED')
         LIMIT 1`,
        [instanceId],
      );
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const id = randomUUID();
      await em.query(
        `INSERT INTO "batch_job_execution"
          (id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params)
         VALUES ($1, $2, 'STARTING', NULL, NULL, '', '', $3)`,
        [id, instanceId, serializeContext(deepClone(params))],
      );
      const rows = await em.query<JobExecutionRow[]>(
        `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
         FROM "batch_job_execution"
         WHERE id = $1
         LIMIT 1`,
        [id],
      );
      if (rows.length === 0) {
        throw new Error(`JobExecution not found immediately after insert: ${id}`);
      }
      return mapJobExecution(rows[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push(`status = $${params.length + 1}`);
      params.push(patch.status);
    }
    if (patch.startTime !== undefined) {
      sets.push(`start_time = $${params.length + 1}`);
      params.push(patch.startTime);
    }
    if (patch.endTime !== undefined) {
      sets.push(`end_time = $${params.length + 1}`);
      params.push(patch.endTime);
    }
    if (patch.exitCode !== undefined) {
      sets.push(`exit_code = $${params.length + 1}`);
      params.push(patch.exitCode);
    }
    if (patch.exitMessage !== undefined) {
      sets.push(`exit_message = $${params.length + 1}`);
      params.push(patch.exitMessage);
    }
    if (sets.length === 0) return;
    params.push(executionId);
    await this.em().query(
      `UPDATE "batch_job_execution" SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const rows = await this.em().query<JobExecutionRow[]>(
      `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
       FROM "batch_job_execution"
       WHERE id = $1
       LIMIT 1`,
      [executionId],
    );
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  override async findJobExecutions(
    filter: JobExecutionFilter = {},
  ): Promise<JobExecution[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.jobInstanceId !== undefined) {
      params.push(filter.jobInstanceId);
      where.push(`job_instance_id = $${params.length}`);
    }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? [...filter.status] : [filter.status];
      const placeholders = statuses.map((status) => {
        params.push(status);
        return `$${params.length}`;
      });
      where.push(`status IN (${placeholders.join(', ')})`);
    }
    if (filter.startedAfter !== undefined) {
      params.push(filter.startedAfter);
      where.push(`start_time >= $${params.length}`);
    }
    if (filter.startedBefore !== undefined) {
      params.push(filter.startedBefore);
      where.push(`start_time <= $${params.length}`);
    }

    const rows = await this.em().query<JobExecutionRow[]>(
      `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
       FROM "batch_job_execution"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY start_time DESC NULLS LAST, id DESC`,
      params,
    );
    return rows.map(mapJobExecution);
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const rows = await this.em().query<JobExecutionRow[]>(
      `SELECT id, job_instance_id, status, start_time, end_time, exit_code, exit_message, params
       FROM "batch_job_execution"
       WHERE job_instance_id = $1 AND status IN ('STARTING', 'STARTED')
       ORDER BY start_time DESC
       LIMIT 1`,
      [jobInstanceId],
    );
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async createStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution> {
    const id = randomUUID();
    await this.em().query(
      `INSERT INTO "batch_step_execution"
        (id, job_execution_id, step_name, status,
         read_count, write_count, skip_count, rollback_count, commit_count,
         exit_code, exit_message, created_at)
       VALUES ($1, $2, $3, 'STARTING', 0, 0, 0, 0, 0, '', '', NOW())`,
      [id, jobExecutionId, stepName],
    );
    const rows = await this.em().query<StepExecutionRow[]>(
      `SELECT id, job_execution_id, step_name, status,
              read_count, write_count, skip_count, rollback_count, commit_count,
              exit_code, exit_message, created_at
       FROM "batch_step_execution"
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (rows.length === 0) {
      throw new Error(`StepExecution not found immediately after insert: ${id}`);
    }
    return mapStepExecution(rows[0]!);
  }

  async updateStepExecution(
    stepExecutionId: string,
    patch: StepExecutionPatch,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push(`status = $${params.length + 1}`);
      params.push(patch.status);
    }
    if (patch.readCount !== undefined) {
      sets.push(`read_count = $${params.length + 1}`);
      params.push(patch.readCount);
    }
    if (patch.writeCount !== undefined) {
      sets.push(`write_count = $${params.length + 1}`);
      params.push(patch.writeCount);
    }
    if (patch.skipCount !== undefined) {
      sets.push(`skip_count = $${params.length + 1}`);
      params.push(patch.skipCount);
    }
    if (patch.rollbackCount !== undefined) {
      sets.push(`rollback_count = $${params.length + 1}`);
      params.push(patch.rollbackCount);
    }
    if (patch.commitCount !== undefined) {
      sets.push(`commit_count = $${params.length + 1}`);
      params.push(patch.commitCount);
    }
    if (patch.exitCode !== undefined) {
      sets.push(`exit_code = $${params.length + 1}`);
      params.push(patch.exitCode);
    }
    if (patch.exitMessage !== undefined) {
      sets.push(`exit_message = $${params.length + 1}`);
      params.push(patch.exitMessage);
    }
    if (sets.length === 0) return;
    params.push(stepExecutionId);
    await this.em().query(
      `UPDATE "batch_step_execution" SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const rows = await this.em().query<StepExecutionRow[]>(
      `SELECT id, job_execution_id, step_name, status,
              read_count, write_count, skip_count, rollback_count, commit_count,
              exit_code, exit_message, created_at
       FROM "batch_step_execution"
       WHERE id = $1
       LIMIT 1`,
      [stepExecutionId],
    );
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  override async findStepExecutions(jobExecutionId: string): Promise<StepExecution[]> {
    const rows = await this.em().query<StepExecutionRow[]>(
      `SELECT id, job_execution_id, step_name, status,
              read_count, write_count, skip_count, rollback_count, commit_count,
              exit_code, exit_message, created_at
       FROM "batch_step_execution"
       WHERE job_execution_id = $1
       ORDER BY created_at ASC, id ASC`,
      [jobExecutionId],
    );
    return rows.map(mapStepExecution);
  }

  /**
   * Postgres has no `ctid` ordering primitive. Order by the
   * `created_at` column descending (the meta-table's `created_at`
   * defaults to `NOW()`), with the v4 UUID as a tie-breaker.
   * Single-writer per `(job_exec, step)` in the test harness and
   * production paths, so the "latest" row is the
   * most-recently-inserted one.
   */
  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = await this.em().query<StepExecutionRow[]>(
      `SELECT id, job_execution_id, step_name, status,
              read_count, write_count, skip_count, rollback_count, commit_count,
              exit_code, exit_message, created_at
       FROM "batch_step_execution"
       WHERE job_execution_id = $1 AND step_name = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [jobExecutionId, stepName],
    );
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const rows = await this.em().query<ContextRow[]>(
        `SELECT data, version FROM "batch_job_execution_context" WHERE job_execution_id = $1 LIMIT 1`,
        [key.slice(5)],
      );
      if (rows.length > 0) {
        return {
          data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
          version: rows[0]!.version,
        };
      }
    } else {
      const rows = await this.em().query<ContextRow[]>(
        `SELECT data, version FROM "batch_step_execution_context" WHERE step_execution_id = $1 LIMIT 1`,
        [key.slice(6)],
      );
      if (rows.length > 0) {
        return {
          data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
          version: rows[0]!.version,
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
      const existing = await this.em().query<ContextRow[]>(
        `SELECT data, version FROM "batch_job_execution_context" WHERE job_execution_id = $1 LIMIT 1`,
        [jobExecutionId],
      );
      const nextVersion = version !== undefined ? version : (existing[0]?.version ?? 0) + 1;
      if (existing.length > 0) {
        await this.em().query(
          `UPDATE "batch_job_execution_context" SET data = $1, version = $2 WHERE job_execution_id = $3`,
          [serialized, nextVersion, jobExecutionId],
        );
      } else {
        await this.em().query(
          `INSERT INTO "batch_job_execution_context" (job_execution_id, data, version) VALUES ($1, $2, $3)`,
          [jobExecutionId, serialized, nextVersion],
        );
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.em().query<ContextRow[]>(
        `SELECT data, version FROM "batch_step_execution_context" WHERE step_execution_id = $1 LIMIT 1`,
        [stepExecutionId],
      );
      const nextVersion = version !== undefined ? version : (existing[0]?.version ?? 0) + 1;
      if (existing.length > 0) {
        await this.em().query(
          `UPDATE "batch_step_execution_context" SET data = $1, version = $2 WHERE step_execution_id = $3`,
          [serialized, nextVersion, stepExecutionId],
        );
      } else {
        await this.em().query(
          `INSERT INTO "batch_step_execution_context" (step_execution_id, data, version) VALUES ($1, $2, $3)`,
          [stepExecutionId, serialized, nextVersion],
        );
      }
    }
  }
}
