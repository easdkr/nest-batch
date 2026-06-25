import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
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
import { TypeOrmDriverProvider } from '../typeorm.driver-provider';

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
    startTime: r.start_time
      ? r.start_time instanceof Date
        ? r.start_time
        : new Date(r.start_time)
      : null,
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
 * TypeORM 1.0.0-backed `JobRepository`.
 *
 * The package is driver-agnostic: the actual `DataSource` is
 * provided by the `@nest-batch/postgresql` (or future
 * `@nest-batch/mysql`) driver sibling via the `TypeOrmDriverProvider`
 * token. The repository itself uses raw SQL via `EntityManager.query`
 * against the table contract represented by this package's exported
 * TypeORM entities. The consuming app owns the runnable migration.
 *
 * The contract guarantees:
 *   - `getOrCreateJobInstance` is race-safe via the (jobName, jobKey)
 *     unique index.
 *   - `createExecutionAtomic` runs inside a single transaction that
 *     (a) idempotently upserts the instance row, (b) acquires a row
 *     lock with `SELECT ... FOR UPDATE SKIP LOCKED` (PostgreSQL) or
 *     a plain select (SQLite test driver), and (c) rejects with
 *     `JobExecutionAlreadyRunningError` if a STARTING/STARTED
 *     execution already exists.
 *   - `saveExecutionContext` deep-clones the data and auto-increments
 *     the version counter when `version` is omitted.
 *   - `findLatestStepExecution` orders by `created_at` descending.
 */
@Injectable()
export class TypeOrmJobRepository extends JobRepository {
  constructor(@Inject(TypeOrmDriverProvider) private readonly dataSource: DataSource) {
    super();
  }

  private em(): EntityManager {
    return this.dataSource.manager;
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = (await this.em().query(
      `SELECT "id", "job_name", "job_key", "created_at"
       FROM "batch_job_instance"
       WHERE "job_name" = $1 AND "job_key" = $2
       LIMIT 1`,
      [name, jobKey],
    )) as JobInstanceRow[];
    if (existing.length > 0) return mapJobInstance(existing[0]!);

    const id = randomUUID();
    try {
      const inserted = (await this.em().query(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT ("job_name", "job_key") DO NOTHING
         RETURNING "id", "job_name", "job_key", "created_at"`,
        [id, name, jobKey],
      )) as JobInstanceRow[];
      if (inserted.length > 0) return mapJobInstance(inserted[0]!);
    } catch {
      // Fall through to read-back.
    }
    const winner = (await this.em().query(
      `SELECT "id", "job_name", "job_key", "created_at"
       FROM "batch_job_instance"
       WHERE "job_name" = $1 AND "job_key" = $2
       LIMIT 1`,
      [name, jobKey],
    )) as JobInstanceRow[];
    if (winner.length === 0) {
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
    return mapJobInstance(winner[0]!);
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    const exec = {
      id: randomUUID(),
      job_instance_id: jobInstanceId,
      status: JobStatus.STARTING,
      start_time: null as Date | null,
      end_time: null as Date | null,
      exit_code: '',
      exit_message: '',
      params: serializeContext(deepClone(params)),
    };
    const rows = (await this.em().query(
      `INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
       RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
      [exec.id, exec.job_instance_id, exec.status, exec.exit_code, exec.exit_message, exec.params],
    )) as JobExecutionRow[];
    return mapJobExecution(rows[0]!);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.dataSource.transaction(async (em) => {
      // 1. Idempotent INSERT.
      const instId = randomUUID();
      await em.query(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT ("job_name", "job_key") DO NOTHING`,
        [instId, name, jobKey],
      );

      // 2. Lock the instance row.
      const isSqlite = this.dataSource.options.type === 'better-sqlite3';
      let instanceId: string;
      if (isSqlite) {
        const rows = (await em.query(
          `SELECT "id" FROM "batch_job_instance"
           WHERE "job_name" = $1 AND "job_key" = $2
           LIMIT 1`,
          [name, jobKey],
        )) as Array<{ id: string }>;
        if (rows.length === 0) {
          throw new JobExecutionAlreadyRunningError(name);
        }
        instanceId = rows[0]!.id;
      } else {
        const rows = (await em.query(
          `SELECT "id" FROM "batch_job_instance"
           WHERE "job_name" = $1 AND "job_key" = $2
           FOR UPDATE SKIP LOCKED`,
          [name, jobKey],
        )) as Array<{ id: string }>;
        if (rows.length === 0) {
          throw new JobExecutionAlreadyRunningError(name);
        }
        instanceId = rows[0]!.id;
      }

      // 3. Under the lock, verify no running execution.
      const running = (await em.query(
        `SELECT "id" FROM "batch_job_execution"
         WHERE "job_instance_id" = $1 AND "status" IN ($2, $3)
         LIMIT 1`,
        [instanceId, JobStatus.STARTING, JobStatus.STARTED],
      )) as Array<{ id: string }>;
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const execId = randomUUID();
      const inserted = (await em.query(
        `INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
         VALUES ($1, $2, $3, NULL, NULL, '', '', $4)
         RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
        [execId, instanceId, JobStatus.STARTING, serializeContext(deepClone(params))],
      )) as JobExecutionRow[];
      return mapJobExecution(inserted[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`"status" = $${i++}`);
      values.push(patch.status);
    }
    if (patch.startTime !== undefined) {
      sets.push(`"start_time" = $${i++}`);
      values.push(patch.startTime);
    }
    if (patch.endTime !== undefined) {
      sets.push(`"end_time" = $${i++}`);
      values.push(patch.endTime);
    }
    if (patch.exitCode !== undefined) {
      sets.push(`"exit_code" = $${i++}`);
      values.push(patch.exitCode);
    }
    if (patch.exitMessage !== undefined) {
      sets.push(`"exit_message" = $${i++}`);
      values.push(patch.exitMessage);
    }
    if (sets.length === 0) return;
    values.push(executionId);
    await this.em().query(
      `UPDATE "batch_job_execution" SET ${sets.join(', ')} WHERE "id" = $${i}`,
      values,
    );
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const rows = (await this.em().query(
      `SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
       FROM "batch_job_execution" WHERE "id" = $1 LIMIT 1`,
      [executionId],
    )) as JobExecutionRow[];
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  override async getJobInstance(jobInstanceId: string): Promise<JobInstance | null> {
    const rows = (await this.em().query(
      `SELECT "id", "job_name", "job_key", "created_at"
       FROM "batch_job_instance"
       WHERE "id" = $1
       LIMIT 1`,
      [jobInstanceId],
    )) as JobInstanceRow[];
    return rows.length > 0 ? mapJobInstance(rows[0]!) : null;
  }

  override async findJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (filter.jobName !== undefined) {
      where.push(`"job_name" = $${i++}`);
      values.push(filter.jobName);
    }
    if (filter.jobKey !== undefined) {
      where.push(`"job_key" = $${i++}`);
      values.push(filter.jobKey);
    }
    const rows = (await this.em().query(
      `SELECT "id", "job_name", "job_key", "created_at"
       FROM "batch_job_instance"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "created_at" ASC, "id" ASC`,
      values,
    )) as JobInstanceRow[];
    return rows.map(mapJobInstance);
  }

  override async findJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (filter.jobInstanceId !== undefined) {
      where.push(`"job_instance_id" = $${i++}`);
      values.push(filter.jobInstanceId);
    }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map(() => `$${i++}`);
      where.push(`"status" IN (${placeholders.join(', ')})`);
      values.push(...statuses);
    }
    if (filter.startedAfter !== undefined) {
      where.push(`"start_time" >= $${i++}`);
      values.push(filter.startedAfter);
    }
    if (filter.startedBefore !== undefined) {
      where.push(`"start_time" <= $${i++}`);
      values.push(filter.startedBefore);
    }
    const rows = (await this.em().query(
      `SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
       FROM "batch_job_execution"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "start_time" DESC NULLS LAST, "id" DESC`,
      values,
    )) as JobExecutionRow[];
    return rows.map(mapJobExecution);
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const rows = (await this.em().query(
      `SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
       FROM "batch_job_execution"
       WHERE "job_instance_id" = $1 AND "status" IN ($2, $3)
       ORDER BY "start_time" DESC NULLS LAST LIMIT 1`,
      [jobInstanceId, JobStatus.STARTING, JobStatus.STARTED],
    )) as JobExecutionRow[];
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    const stepId = randomUUID();
    const rows = (await this.em().query(
      `INSERT INTO "batch_step_execution" ("id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at")
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, '', '', NOW())
       RETURNING "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"`,
      [stepId, jobExecutionId, stepName, StepStatus.STARTING],
    )) as StepExecutionRow[];
    return mapStepExecution(rows[0]!);
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`"status" = $${i++}`);
      values.push(patch.status);
    }
    if (patch.readCount !== undefined) {
      sets.push(`"read_count" = $${i++}`);
      values.push(patch.readCount);
    }
    if (patch.writeCount !== undefined) {
      sets.push(`"write_count" = $${i++}`);
      values.push(patch.writeCount);
    }
    if (patch.skipCount !== undefined) {
      sets.push(`"skip_count" = $${i++}`);
      values.push(patch.skipCount);
    }
    if (patch.rollbackCount !== undefined) {
      sets.push(`"rollback_count" = $${i++}`);
      values.push(patch.rollbackCount);
    }
    if (patch.commitCount !== undefined) {
      sets.push(`"commit_count" = $${i++}`);
      values.push(patch.commitCount);
    }
    if (patch.exitCode !== undefined) {
      sets.push(`"exit_code" = $${i++}`);
      values.push(patch.exitCode);
    }
    if (patch.exitMessage !== undefined) {
      sets.push(`"exit_message" = $${i++}`);
      values.push(patch.exitMessage);
    }
    if (sets.length === 0) return;
    values.push(stepExecutionId);
    await this.em().query(
      `UPDATE "batch_step_execution" SET ${sets.join(', ')} WHERE "id" = $${i}`,
      values,
    );
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const rows = (await this.em().query(
      `SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
       FROM "batch_step_execution" WHERE "id" = $1 LIMIT 1`,
      [stepExecutionId],
    )) as StepExecutionRow[];
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  override async findStepExecutions(jobExecutionId: string): Promise<StepExecution[]> {
    const rows = (await this.em().query(
      `SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
       FROM "batch_step_execution"
       WHERE "job_execution_id" = $1
       ORDER BY "created_at" ASC, "id" ASC`,
      [jobExecutionId],
    )) as StepExecutionRow[];
    return rows.map(mapStepExecution);
  }

  /**
   * Find the most recently created step execution for the given
   * `(jobExecutionId, stepName)` pair, or `null` when none exists.
   * Insertion order is determined by the `created_at` column; the
   * primary key is a v4 UUID which is random, so a `id DESC` order
   * would not correspond to insertion time. The `created_at DESC,
   * id DESC` secondary order keeps the result stable when two rows
   * share the same `CURRENT_TIMESTAMP` resolution.
   */
  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = (await this.em().query(
      `SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
       FROM "batch_step_execution"
       WHERE "job_execution_id" = $1 AND "step_name" = $2
       ORDER BY "created_at" DESC, "id" DESC
       LIMIT 1`,
      [jobExecutionId, stepName],
    )) as StepExecutionRow[];
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const rows = (await this.em().query(
        `SELECT "data", "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = $1 LIMIT 1`,
        [key.slice(5)],
      )) as ContextRow[];
      if (rows.length > 0) {
        return {
          data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
          version: rows[0]!.version,
        };
      }
    } else {
      const rows = (await this.em().query(
        `SELECT "data", "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = $1 LIMIT 1`,
        [key.slice(6)],
      )) as ContextRow[];
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
      const existing = (await this.em().query(
        `SELECT "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = $1 LIMIT 1`,
        [jobExecutionId],
      )) as ContextRow[];
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 0;
      if (existing.length > 0) {
        await this.em().query(
          `UPDATE "batch_job_execution_context" SET "data" = $1, "version" = $2 WHERE "job_execution_id" = $3`,
          [serialized, nextVersion, jobExecutionId],
        );
      } else {
        await this.em().query(
          `INSERT INTO "batch_job_execution_context" ("job_execution_id", "data", "version") VALUES ($1, $2, $3)`,
          [jobExecutionId, serialized, nextVersion],
        );
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = (await this.em().query(
        `SELECT "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = $1 LIMIT 1`,
        [stepExecutionId],
      )) as ContextRow[];
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 0;
      if (existing.length > 0) {
        await this.em().query(
          `UPDATE "batch_step_execution_context" SET "data" = $1, "version" = $2 WHERE "step_execution_id" = $3`,
          [serialized, nextVersion, stepExecutionId],
        );
      } else {
        await this.em().query(
          `INSERT INTO "batch_step_execution_context" ("step_execution_id", "data", "version") VALUES ($1, $2, $3)`,
          [stepExecutionId, serialized, nextVersion],
        );
      }
    }
  }
}
