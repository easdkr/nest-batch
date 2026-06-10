import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { sql } from 'drizzle-orm';
import { DrizzleDriverProvider } from '../drizzle.driver-provider';

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

/**
 * Normalize the result of a Drizzle `db.execute(sql\`SELECT ...\`)`
 * call to a plain array. Drizzle's `execute()` return shape varies
 * by driver: the `pg` / `node-postgres` driver returns a
 * `QueryResult`-like object with a `.rows` property, while the
 * `libsql` and `mysql2` drivers return a raw array or a
 * `ResultSetHeader` (depending on the query type). The slot is
 * driver-agnostic; this helper accepts any of the three shapes
 * and returns the underlying row array so the cast
 * `as JobInstanceRow[]` is honest.
 */
function rowsOf<T>(result: unknown): T[] {
  if (result == null) return [];
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object') {
    const maybe = (result as { rows?: unknown }).rows;
    if (Array.isArray(maybe)) return maybe as T[];
  }
  return [];
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
 * Drizzle ORM-backed `JobRepository`.
 *
 * The package is driver-agnostic: the actual Drizzle `Database`
 * (e.g. `NodePgDatabase` for Postgres, `MySql2Database` for MySQL)
 * is provided by the `@nest-batch/postgresql` (or future
 * `@nest-batch/mysql`) driver sibling via the
 * `DrizzleDriverProvider` token. The repository itself uses
 * driver-agnostic raw SQL via the `sql` template tag from
 * `drizzle-orm` (NOT from `drizzle-orm/pg-core` or
 * `drizzle-orm/mysql-core`).
 */
@Injectable()
export class DrizzleJobRepository extends JobRepository {
  // The Drizzle `Database` is generic over a schema. The slot
  // pattern casts to `unknown` for the slot side; the driver
  // sibling holds the concrete schema and casts on its side.
  // `any` is intentional: the slot repository uses raw SQL
  // (`sql` template), so the schema type is opaque to it.
  constructor(@Inject(DrizzleDriverProvider) private readonly db: any) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = rowsOf<JobInstanceRow>(
      await this.db.execute(
        sql`SELECT "id", "job_name", "job_key", "created_at"
            FROM "batch_job_instance"
            WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
            LIMIT 1`,
      ),
    );
    if (existing.length > 0) return mapJobInstance(existing[0]!);

    const id = randomUUID();
    try {
      const inserted = rowsOf<JobInstanceRow>(
        await this.db.execute(
          sql`INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
              VALUES (${id}, ${name}, ${jobKey}, NOW())
              ON CONFLICT ("job_name", "job_key") DO NOTHING
              RETURNING "id", "job_name", "job_key", "created_at"`,
        ),
      );
      if (inserted.length > 0) return mapJobInstance(inserted[0]!);
    } catch {
      // Fall through to read-back.
    }
    const winner = rowsOf<JobInstanceRow>(
      await this.db.execute(
        sql`SELECT "id", "job_name", "job_key", "created_at"
            FROM "batch_job_instance"
            WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
            LIMIT 1`,
      ),
    );
    if (winner.length === 0) {
      throw new Error(`Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`);
    }
    return mapJobInstance(winner[0]!);
  }

  async createJobExecution(
    jobInstanceId: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    const execId = randomUUID();
    const execParams = serializeContext(deepClone(params));
    const rows = rowsOf<JobExecutionRow>(
      await this.db.execute(
        sql`INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
            VALUES (${execId}, ${jobInstanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
            RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
      ),
    );
    return mapJobExecution(rows[0]!);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.db.transaction(async (tx: any) => {
      // 1. Idempotent INSERT.
      const instId = randomUUID();
      await tx.execute(
        sql`INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
            VALUES (${instId}, ${name}, ${jobKey}, NOW())
            ON CONFLICT ("job_name", "job_key") DO NOTHING`,
      );

      // 2. Lock the instance row with FOR UPDATE SKIP LOCKED.
      const locked = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT "id", "job_name", "job_key", "created_at"
              FROM "batch_job_instance"
              WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
              FOR UPDATE SKIP LOCKED
              LIMIT 1`,
        ),
      );
      if (locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      // 3. Under the lock, verify no running execution.
      const running = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT "id" FROM "batch_job_execution"
              WHERE "job_instance_id" = ${instanceId}
                AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
              LIMIT 1`,
        ),
      );
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const execId = randomUUID();
      const execParams = serializeContext(deepClone(params));
      const inserted = rowsOf<JobExecutionRow>(
        await tx.execute(
          sql`INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
              VALUES (${execId}, ${instanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
              RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"`,
        ),
      );
      return mapJobExecution(inserted[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const sets: ReturnType<typeof sql>[] = [];
    if (patch.status !== undefined) sets.push(sql`"status" = ${patch.status}`);
    if (patch.startTime !== undefined) sets.push(sql`"start_time" = ${patch.startTime}`);
    if (patch.endTime !== undefined) sets.push(sql`"end_time" = ${patch.endTime}`);
    if (patch.exitCode !== undefined) sets.push(sql`"exit_code" = ${patch.exitCode}`);
    if (patch.exitMessage !== undefined) sets.push(sql`"exit_message" = ${patch.exitMessage}`);
    if (sets.length === 0) return;
    await this.db.execute(
      sql`UPDATE "batch_job_execution" SET ${sql.join(sets, sql`, `)} WHERE "id" = ${executionId}`,
    );
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const rows = rowsOf<JobExecutionRow>(
      await this.db.execute(
        sql`SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
            FROM "batch_job_execution" WHERE "id" = ${executionId} LIMIT 1`,
      ),
    );
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const rows = rowsOf<JobExecutionRow>(
      await this.db.execute(
        sql`SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
            FROM "batch_job_execution"
            WHERE "job_instance_id" = ${jobInstanceId}
              AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
            ORDER BY "start_time" DESC NULLS LAST
            LIMIT 1`,
      ),
    );
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async createStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution> {
    const stepId = randomUUID();
    const rows = rowsOf<StepExecutionRow>(
      await this.db.execute(
        sql`INSERT INTO "batch_step_execution" ("id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at")
            VALUES (${stepId}, ${jobExecutionId}, ${stepName}, ${StepStatus.STARTING}, 0, 0, 0, 0, 0, '', '', NOW())
            RETURNING "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"`,
      ),
    );
    return mapStepExecution(rows[0]!);
  }

  async updateStepExecution(
    stepExecutionId: string,
    patch: StepExecutionPatch,
  ): Promise<void> {
    const sets: ReturnType<typeof sql>[] = [];
    if (patch.status !== undefined) sets.push(sql`"status" = ${patch.status}`);
    if (patch.readCount !== undefined) sets.push(sql`"read_count" = ${patch.readCount}`);
    if (patch.writeCount !== undefined) sets.push(sql`"write_count" = ${patch.writeCount}`);
    if (patch.skipCount !== undefined) sets.push(sql`"skip_count" = ${patch.skipCount}`);
    if (patch.rollbackCount !== undefined) sets.push(sql`"rollback_count" = ${patch.rollbackCount}`);
    if (patch.commitCount !== undefined) sets.push(sql`"commit_count" = ${patch.commitCount}`);
    if (patch.exitCode !== undefined) sets.push(sql`"exit_code" = ${patch.exitCode}`);
    if (patch.exitMessage !== undefined) sets.push(sql`"exit_message" = ${patch.exitMessage}`);
    if (sets.length === 0) return;
    await this.db.execute(
      sql`UPDATE "batch_step_execution" SET ${sql.join(sets, sql`, `)} WHERE "id" = ${stepExecutionId}`,
    );
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const rows = rowsOf<StepExecutionRow>(
      await this.db.execute(
        sql`SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
            FROM "batch_step_execution" WHERE "id" = ${stepExecutionId} LIMIT 1`,
      ),
    );
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = rowsOf<StepExecutionRow>(
      await this.db.execute(
        sql`SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
            FROM "batch_step_execution"
            WHERE "job_execution_id" = ${jobExecutionId} AND "step_name" = ${stepName}
            ORDER BY "created_at" DESC, "id" DESC
            LIMIT 1`,
      ),
    );
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const rows = rowsOf<ContextRow>(
        await this.db.execute(
          sql`SELECT "data", "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ${key.slice(5)} LIMIT 1`,
        ),
      );
      if (rows.length > 0) {
        return {
          data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
          version: rows[0]!.version,
        };
      }
    } else {
      const rows = rowsOf<ContextRow>(
        await this.db.execute(
          sql`SELECT "data", "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ${key.slice(6)} LIMIT 1`,
        ),
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
      const existing = rowsOf<ContextRow>(
        await this.db.execute(
          sql`SELECT "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ${jobExecutionId} LIMIT 1`,
        ),
      );
      const nextVersion = version !== undefined ? version : (existing.length > 0 ? existing[0]!.version + 1 : 1);
      if (existing.length > 0) {
        await this.db.execute(
          sql`UPDATE "batch_job_execution_context" SET "data" = ${serialized}, "version" = ${nextVersion} WHERE "job_execution_id" = ${jobExecutionId}`,
        );
      } else {
        await this.db.execute(
          sql`INSERT INTO "batch_job_execution_context" ("job_execution_id", "data", "version") VALUES (${jobExecutionId}, ${serialized}, ${nextVersion})`,
        );
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = rowsOf<ContextRow>(
        await this.db.execute(
          sql`SELECT "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ${stepExecutionId} LIMIT 1`,
        ),
      );
      const nextVersion = version !== undefined ? version : (existing.length > 0 ? existing[0]!.version + 1 : 1);
      if (existing.length > 0) {
        await this.db.execute(
          sql`UPDATE "batch_step_execution_context" SET "data" = ${serialized}, "version" = ${nextVersion} WHERE "step_execution_id" = ${stepExecutionId}`,
        );
      } else {
        await this.db.execute(
          sql`INSERT INTO "batch_step_execution_context" ("step_execution_id", "data", "version") VALUES (${stepExecutionId}, ${serialized}, ${nextVersion})`,
        );
      }
    }
  }
}
