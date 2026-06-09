import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/core';
import type { Connection } from '@mikro-orm/core';
import { JobRepository, JobExecutionAlreadyRunningError } from '@nest-batch/core';
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
import { JobStatus, StepStatus } from '@nest-batch/core';
import { assertJsonSerializable, serializeContext, deserializeContext } from '@nest-batch/core';
import { MikroOrmDriverProvider } from './mikro-orm.driver-provider';
import { randomUUID } from 'crypto';

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

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

function mapJobInstance(r: {
  id: string;
  job_name: string;
  job_key: string;
  created_at: string | Date;
}): JobInstance {
  return {
    id: r.id,
    jobName: r.job_name,
    jobKey: r.job_key,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  };
}

function mapJobExecution(r: {
  id: string;
  job_instance_id: string;
  status: string;
  start_time: string | Date | null;
  end_time: string | Date | null;
  exit_code: string;
  exit_message: string;
  params: string;
}): JobExecution {
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

function mapStepExecution(r: {
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
}): StepExecution {
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
 * Cast the EntityManager to a connection that has an `execute(sql,
 * params)` method. The base `EntityManager` exposes `getConnection()`,
 * which returns the driver-specific connection (a `Connection` from
 * `@mikro-orm/core` with an abstract `execute` method). The runtime
 * connection is always SQL-capable; the cast is just to satisfy the
 * TypeScript base-class type.
 */
function conn(em: EntityManager): Connection {
  return em.getConnection() as unknown as Connection;
}

async function execQuery<T = Record<string, unknown>>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = (await conn(em).execute(sql, params, 'all')) as T[] | { rows?: T[] } | unknown;
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

@Injectable()
export class MikroORMJobRepository extends JobRepository {
  constructor(
    @Inject(MikroOrmDriverProvider) private readonly em: EntityManager,
  ) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    return RequestContext.create(this.em, async () => {
      const existing = await execQuery<{
        id: string;
        job_name: string;
        job_key: string;
        created_at: string;
      }>(
        this.em,
        `SELECT "id", "job_name", "job_key", "created_at" FROM "batch_job_instance" WHERE "job_name" = ? AND "job_key" = ? LIMIT 1`,
        [name, jobKey],
      );
      if (existing.length > 0) return mapJobInstance(existing[0]!);

      // Try to INSERT; on unique-constraint violation, another caller
      // won the race — read the committed row.
      const id = randomUUID();
      try {
        const inserted = await execQuery<{ id: string; created_at: string }>(
          this.em,
          `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
           VALUES (?, ?, ?, NOW())
           ON CONFLICT ("job_name", "job_key") DO NOTHING
           RETURNING "id", "created_at"`,
          [id, name, jobKey],
        );
        if (inserted.length > 0) {
          return {
            id,
            jobName: name,
            jobKey,
            createdAt: new Date(inserted[0]!.created_at),
          };
        }
      } catch {
        // Fall through to read-back.
      }

      const winner = await execQuery<{
        id: string;
        job_name: string;
        job_key: string;
        created_at: string;
      }>(
        this.em,
        `SELECT "id", "job_name", "job_key", "created_at" FROM "batch_job_instance" WHERE "job_name" = ? AND "job_key" = ? LIMIT 1`,
        [name, jobKey],
      );
      if (winner.length === 0) {
        throw new Error(`JobInstance race lost but no row found for (${name}, ${jobKey})`);
      }
      return mapJobInstance(winner[0]!);
    });
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    return RequestContext.create(this.em, async () => {
      const exec = {
        id: randomUUID(),
        job_instance_id: jobInstanceId,
        status: JobStatus.STARTING,
        start_time: null,
        end_time: null,
        exit_code: '',
        exit_message: '',
        params: serializeContext(deepClone(params)),
      };
      const rows = await execQuery<{
        id: string;
        job_instance_id: string;
        status: string;
        start_time: string | null;
        end_time: string | null;
        exit_code: string;
        exit_message: string;
        params: string;
      }>(
        this.em,
        `INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
        [exec.id, exec.job_instance_id, exec.status, exec.exit_code, exec.exit_message, exec.params],
      );
      return mapJobExecution(rows[0]!);
    });
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.em.transactional(async (em) => {
      // 1. Ensure the JobInstance row exists (idempotent INSERT).
      const instId = randomUUID();
      await execQuery(
        em,
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES (?, ?, ?, NOW())
         ON CONFLICT ("job_name", "job_key") DO NOTHING`,
        [instId, name, jobKey],
      );

      // 2. Lock the instance row with FOR UPDATE SKIP LOCKED.
      const locked = await execQuery<{ id: string }>(
        em,
        `SELECT "id" FROM "batch_job_instance"
         WHERE "job_name" = ? AND "job_key" = ?
         FOR UPDATE SKIP LOCKED`,
        [name, jobKey],
      );
      if (locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      // 3. Under the lock, verify no running execution.
      const running = await execQuery<{ id: string }>(
        em,
        `SELECT "id" FROM "batch_job_execution"
         WHERE "job_instance_id" = ? AND "status" IN (?, ?)
         LIMIT 1`,
        [instanceId, JobStatus.STARTING, JobStatus.STARTED],
      );
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const execId = randomUUID();
      const rows = await execQuery<{
        id: string;
        job_instance_id: string;
        status: string;
        start_time: string | null;
        end_time: string | null;
        exit_code: string;
        exit_message: string;
        params: string;
      }>(
        em,
        `INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
         VALUES (?, ?, ?, NULL, NULL, '', '', ?)
         RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
        [execId, instanceId, JobStatus.STARTING, serializeContext(deepClone(params))],
      );
      return mapJobExecution(rows[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    return RequestContext.create(this.em, async () => {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) { sets.push(`"status" = ?`); values.push(patch.status); }
      if (patch.startTime !== undefined) { sets.push(`"start_time" = ?`); values.push(patch.startTime); }
      if (patch.endTime !== undefined) { sets.push(`"end_time" = ?`); values.push(patch.endTime); }
      if (patch.exitCode !== undefined) { sets.push(`"exit_code" = ?`); values.push(patch.exitCode); }
      if (patch.exitMessage !== undefined) { sets.push(`"exit_message" = ?`); values.push(patch.exitMessage); }
      if (sets.length === 0) return;
      values.push(executionId);
      await execQuery(
        this.em,
        `UPDATE "batch_job_execution" SET ${sets.join(', ')} WHERE "id" = ?`,
        values,
      );
    });
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    return RequestContext.create(this.em, async () => {
      const rows = await execQuery<{
        id: string;
        job_instance_id: string;
        status: string;
        start_time: string | null;
        end_time: string | null;
        exit_code: string;
        exit_message: string;
        params: string;
      }>(
        this.em,
        `SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
         FROM "batch_job_execution" WHERE "id" = ? LIMIT 1`,
        [executionId],
      );
      return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
    });
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    return RequestContext.create(this.em, async () => {
      const rows = await execQuery<{
        id: string;
        job_instance_id: string;
        status: string;
        start_time: string | null;
        end_time: string | null;
        exit_code: string;
        exit_message: string;
        params: string;
      }>(
        this.em,
        `SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
         FROM "batch_job_execution"
         WHERE "job_instance_id" = ? AND "status" IN (?, ?)
         ORDER BY "start_time" DESC NULLS LAST LIMIT 1`,
        [jobInstanceId, JobStatus.STARTING, JobStatus.STARTED],
      );
      return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
    });
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    return RequestContext.create(this.em, async () => {
      const stepId = randomUUID();
      const rows = await execQuery<{
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
      }>(
        this.em,
        `INSERT INTO "batch_step_execution" ("id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message")
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '', '')
         RETURNING "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message"`,
        [stepId, jobExecutionId, stepName, StepStatus.STARTING],
      );
      return mapStepExecution(rows[0]!);
    });
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    return RequestContext.create(this.em, async () => {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) { sets.push(`"status" = ?`); values.push(patch.status); }
      if (patch.readCount !== undefined) { sets.push(`"read_count" = ?`); values.push(patch.readCount); }
      if (patch.writeCount !== undefined) { sets.push(`"write_count" = ?`); values.push(patch.writeCount); }
      if (patch.skipCount !== undefined) { sets.push(`"skip_count" = ?`); values.push(patch.skipCount); }
      if (patch.rollbackCount !== undefined) { sets.push(`"rollback_count" = ?`); values.push(patch.rollbackCount); }
      if (patch.commitCount !== undefined) { sets.push(`"commit_count" = ?`); values.push(patch.commitCount); }
      if (patch.exitCode !== undefined) { sets.push(`"exit_code" = ?`); values.push(patch.exitCode); }
      if (patch.exitMessage !== undefined) { sets.push(`"exit_message" = ?`); values.push(patch.exitMessage); }
      if (sets.length === 0) return;
      values.push(stepExecutionId);
      await execQuery(
        this.em,
        `UPDATE "batch_step_execution" SET ${sets.join(', ')} WHERE "id" = ?`,
        values,
      );
    });
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    return RequestContext.create(this.em, async () => {
      const rows = await execQuery<{
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
      }>(
        this.em,
        `SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message"
         FROM "batch_step_execution" WHERE "id" = ? LIMIT 1`,
        [stepExecutionId],
      );
      return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
    });
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    return RequestContext.create(this.em, async () => {
      // Order by `ctid` (physical row id, monotonic per insert) — the
      // primary key is a v4 UUID (random bytes), so `id DESC` does not
      // correspond to insertion order. The existing
      // `batch_step_execution_job_execution_id_index` covers the
      // filter, so this is one index range scan + 1-row read.
      const rows = await execQuery<{
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
      }>(
        this.em,
        `SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message"
         FROM "batch_step_execution"
         WHERE "job_execution_id" = ? AND "step_name" = ?
         ORDER BY ctid DESC LIMIT 1`,
        [jobExecutionId, stepName],
      );
      return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
    });
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    return RequestContext.create(this.em, async () => {
      const key = scopeKey(scope);
      if (key.startsWith('job::')) {
        const rows = await execQuery<{ data: string; version: number }>(
          this.em,
          `SELECT "data", "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ? LIMIT 1`,
          [key.slice(5)],
        );
        if (rows.length > 0) {
          return {
            data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
            version: rows[0]!.version,
          };
        }
      } else {
        const rows = await execQuery<{ data: string; version: number }>(
          this.em,
          `SELECT "data", "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ? LIMIT 1`,
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
    });
  }

  async saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void> {
    assertJsonSerializable(ctx.data);
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const key = scopeKey(scope);
      const serialized = serializeContext(ctx.data);
      if (key.startsWith('job::')) {
        const jobExecutionId = key.slice(5);
        const rows = await execQuery<{ version: number }>(
          em,
          `SELECT "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ? LIMIT 1`,
          [jobExecutionId],
        );
        const nextVersion = version !== undefined ? version : (rows.length > 0 ? rows[0]!.version + 1 : 0);
        if (rows.length > 0) {
          await execQuery(
            em,
            `UPDATE "batch_job_execution_context" SET "data" = ?, "version" = ? WHERE "job_execution_id" = ?`,
            [serialized, nextVersion, jobExecutionId],
          );
        } else {
          await execQuery(
            em,
            `INSERT INTO "batch_job_execution_context" ("job_execution_id", "data", "version") VALUES (?, ?, ?)`,
            [jobExecutionId, serialized, nextVersion],
          );
        }
      } else {
        const stepExecutionId = key.slice(6);
        const rows = await execQuery<{ version: number }>(
          em,
          `SELECT "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ? LIMIT 1`,
          [stepExecutionId],
        );
        const nextVersion = version !== undefined ? version : (rows.length > 0 ? rows[0]!.version + 1 : 0);
        if (rows.length > 0) {
          await execQuery(
            em,
            `UPDATE "batch_step_execution_context" SET "data" = ?, "version" = ? WHERE "step_execution_id" = ?`,
            [serialized, nextVersion, stepExecutionId],
          );
        } else {
          await execQuery(
            em,
            `INSERT INTO "batch_step_execution_context" ("step_execution_id", "data", "version") VALUES (?, ?, ?)`,
            [stepExecutionId, serialized, nextVersion],
          );
        }
      }
    });
  }
}
