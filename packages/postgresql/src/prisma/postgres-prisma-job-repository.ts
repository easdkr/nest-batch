import { Injectable } from '@nestjs/common';
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
  JobInstanceFilter,
  JobExecutionFilter,
} from '@nest-batch/core';
import { Prisma, type PrismaClient } from '@prisma/client';

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

function mapJobInstance(e: {
  id: string;
  job_name: string;
  job_key: string;
  created_at: Date | string;
}): JobInstance {
  return {
    id: e.id,
    jobName: e.job_name,
    jobKey: e.job_key,
    createdAt: e.created_at instanceof Date ? e.created_at : new Date(e.created_at),
  };
}

function mapJobExecution(e: {
  id: string;
  job_instance_id: string;
  status: string;
  start_time: Date | string | null;
  end_time: Date | string | null;
  exit_code: string;
  exit_message: string;
  params: string;
}): JobExecution {
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
    jobInstanceId: e.job_instance_id,
    status: e.status as JobStatus,
    startTime: e.start_time
      ? e.start_time instanceof Date
        ? e.start_time
        : new Date(e.start_time)
      : null,
    endTime: e.end_time ? (e.end_time instanceof Date ? e.end_time : new Date(e.end_time)) : null,
    exitCode: e.exit_code,
    exitMessage: e.exit_message,
    params,
  };
}

function mapStepExecution(e: {
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
  created_at: Date | string;
}): StepExecution {
  return {
    id: e.id,
    jobExecutionId: e.job_execution_id,
    stepName: e.step_name,
    status: e.status as StepStatus,
    readCount: e.read_count,
    writeCount: e.write_count,
    skipCount: e.skip_count,
    rollbackCount: e.rollback_count,
    commitCount: e.commit_count,
    startTime: null,
    endTime: null,
    exitCode: e.exit_code,
    exitMessage: e.exit_message,
  };
}

/**
 * PostgreSQL-flavored Prisma `JobRepository`.
 *
 * Mirrors the MySQL `MysqlPrismaJobRepository` in `@nest-batch/mysql`
 * exactly: same model shape, same column names, same contract
 * invariants. The raw SQL uses Postgres-compatible syntax
 * (double-quote identifiers, `INSERT ... ON CONFLICT (...) DO NOTHING`,
 * `NOW()`) because the host provides a `PrismaClient` generated
 * against the PostgreSQL Prisma schema owned by `@nest-batch/prisma`.
 */
@Injectable()
export class PostgresPrismaJobRepository extends JobRepository {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = await this.prisma.$queryRaw<JobInstanceRow[]>(
      Prisma.sql`SELECT "id", "job_name", "job_key", "created_at"
                 FROM "batch_job_instance"
                 WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
                 LIMIT 1`,
    );
    if (existing.length > 0) return mapJobInstance(existing[0]!);

    const id = randomUUID();
    try {
      const created = await this.prisma.$queryRaw<JobInstanceRow[]>(
        Prisma.sql`INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
                   VALUES (${id}, ${name}, ${jobKey}, NOW())
                   ON CONFLICT ("job_name", "job_key") DO NOTHING
                   RETURNING "id", "job_name", "job_key", "created_at"`,
      );
      if (created.length > 0) return mapJobInstance(created[0]!);
    } catch {
      // Fall through to read-back.
    }

    const winner = await this.prisma.$queryRaw<JobInstanceRow[]>(
      Prisma.sql`SELECT "id", "job_name", "job_key", "created_at"
                 FROM "batch_job_instance"
                 WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
                 LIMIT 1`,
    );
    if (winner.length === 0) {
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
    return mapJobInstance(winner[0]!);
  }

  override async getJobInstance(jobInstanceId: string): Promise<JobInstance | null> {
    const rows = await this.prisma.$queryRaw<JobInstanceRow[]>(
      Prisma.sql`SELECT "id", "job_name", "job_key", "created_at"
                 FROM "batch_job_instance"
                 WHERE "id" = ${jobInstanceId}
                 LIMIT 1`,
    );
    return rows.length > 0 ? mapJobInstance(rows[0]!) : null;
  }

  override async findJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.jobName !== undefined) {
      params.push(filter.jobName);
      where.push(`"job_name" = $${params.length}`);
    }
    if (filter.jobKey !== undefined) {
      params.push(filter.jobKey);
      where.push(`"job_key" = $${params.length}`);
    }

    const rows = await this.prisma.$queryRawUnsafe<JobInstanceRow[]>(
      `SELECT "id", "job_name", "job_key", "created_at"
       FROM "batch_job_instance"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "created_at" ASC, "id" ASC`,
      ...params,
    );
    return rows.map(mapJobInstance);
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    const execId = randomUUID();
    const execParams = serializeContext(deepClone(params));
    const exec = await this.prisma.$queryRaw<JobExecutionRow[]>(
      Prisma.sql`INSERT INTO "batch_job_execution"
                  ("id", "job_instance_id", "status", "start_time", "end_time",
                   "exit_code", "exit_message", "params")
                 VALUES (${execId}, ${jobInstanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
                 RETURNING "id", "job_instance_id", "status", "start_time", "end_time",
                           "exit_code", "exit_message", "params"`,
    );
    return mapJobExecution(exec[0]!);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.prisma.$transaction(async (tx) => {
      const instId = randomUUID();
      // Postgres UPSERT: `INSERT ... ON CONFLICT (...) DO NOTHING`.
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
                   VALUES (${instId}, ${name}, ${jobKey}, NOW())
                   ON CONFLICT ("job_name", "job_key") DO NOTHING`,
      );

      const locked = await tx.$queryRaw<JobInstanceRow[]>(
        Prisma.sql`SELECT "id", "job_name", "job_key", "created_at"
                   FROM "batch_job_instance"
                   WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1`,
      );
      if (!locked || locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      const running = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "batch_job_execution"
                   WHERE "job_instance_id" = ${instanceId}
                     AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
                   LIMIT 1`,
      );
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      const execId = randomUUID();
      const execParams = serializeContext(deepClone(params));
      const inserted = await tx.$queryRaw<JobExecutionRow[]>(
        Prisma.sql`INSERT INTO "batch_job_execution"
                    ("id", "job_instance_id", "status", "start_time", "end_time",
                     "exit_code", "exit_message", "params")
                   VALUES (${execId}, ${instanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
                   RETURNING "id", "job_instance_id", "status", "start_time", "end_time",
                             "exit_code", "exit_message", "params"`,
      );
      return mapJobExecution(inserted[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    if (patch.status !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_job_execution" SET "status" = ${patch.status} WHERE "id" = ${executionId}`,
      );
    }
    if (patch.startTime !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_job_execution" SET "start_time" = ${patch.startTime} WHERE "id" = ${executionId}`,
      );
    }
    if (patch.endTime !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_job_execution" SET "end_time" = ${patch.endTime} WHERE "id" = ${executionId}`,
      );
    }
    if (patch.exitCode !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_job_execution" SET "exit_code" = ${patch.exitCode} WHERE "id" = ${executionId}`,
      );
    }
    if (patch.exitMessage !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_job_execution" SET "exit_message" = ${patch.exitMessage} WHERE "id" = ${executionId}`,
      );
    }
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const e = await this.prisma.$queryRaw<JobExecutionRow[]>(
      Prisma.sql`SELECT "id", "job_instance_id", "status", "start_time", "end_time",
                        "exit_code", "exit_message", "params"
                 FROM "batch_job_execution" WHERE "id" = ${executionId} LIMIT 1`,
    );
    return e.length > 0 ? mapJobExecution(e[0]!) : null;
  }

  override async findJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.jobInstanceId !== undefined) {
      params.push(filter.jobInstanceId);
      where.push(`"job_instance_id" = $${params.length}`);
    }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? [...filter.status] : [filter.status];
      const placeholders = statuses.map((status) => {
        params.push(status);
        return `$${params.length}`;
      });
      where.push(`"status" IN (${placeholders.join(', ')})`);
    }
    if (filter.startedAfter !== undefined) {
      params.push(filter.startedAfter);
      where.push(`"start_time" >= $${params.length}`);
    }
    if (filter.startedBefore !== undefined) {
      params.push(filter.startedBefore);
      where.push(`"start_time" <= $${params.length}`);
    }

    const rows = await this.prisma.$queryRawUnsafe<JobExecutionRow[]>(
      `SELECT "id", "job_instance_id", "status", "start_time", "end_time",
              "exit_code", "exit_message", "params"
       FROM "batch_job_execution"
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "start_time" DESC NULLS LAST, "id" DESC`,
      ...params,
    );
    return rows.map(mapJobExecution);
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const e = await this.prisma.$queryRaw<JobExecutionRow[]>(
      Prisma.sql`SELECT "id", "job_instance_id", "status", "start_time", "end_time",
                        "exit_code", "exit_message", "params"
                 FROM "batch_job_execution"
                 WHERE "job_instance_id" = ${jobInstanceId}
                   AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
                 ORDER BY "start_time" DESC NULLS LAST
                 LIMIT 1`,
    );
    return e.length > 0 ? mapJobExecution(e[0]!) : null;
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    const stepId = randomUUID();
    const step = await this.prisma.$queryRaw<StepExecutionRow[]>(
      Prisma.sql`INSERT INTO "batch_step_execution"
                  ("id", "job_execution_id", "step_name", "status",
                   "read_count", "write_count", "skip_count", "rollback_count", "commit_count",
                   "exit_code", "exit_message", "created_at")
                 VALUES (${stepId}, ${jobExecutionId}, ${stepName}, ${StepStatus.STARTING},
                         0, 0, 0, 0, 0, '', '', NOW())
                 RETURNING "id", "job_execution_id", "step_name", "status",
                           "read_count", "write_count", "skip_count", "rollback_count", "commit_count",
                           "exit_code", "exit_message", "created_at"`,
    );
    return mapStepExecution(step[0]!);
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    if (patch.status !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "status" = ${patch.status} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.readCount !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "read_count" = ${patch.readCount} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.writeCount !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "write_count" = ${patch.writeCount} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.skipCount !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "skip_count" = ${patch.skipCount} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.rollbackCount !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "rollback_count" = ${patch.rollbackCount} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.commitCount !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "commit_count" = ${patch.commitCount} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.exitCode !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "exit_code" = ${patch.exitCode} WHERE "id" = ${stepExecutionId}`,
      );
    }
    if (patch.exitMessage !== undefined) {
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "batch_step_execution" SET "exit_message" = ${patch.exitMessage} WHERE "id" = ${stepExecutionId}`,
      );
    }
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const s = await this.prisma.$queryRaw<StepExecutionRow[]>(
      Prisma.sql`SELECT "id", "job_execution_id", "step_name", "status",
                        "read_count", "write_count", "skip_count", "rollback_count", "commit_count",
                        "exit_code", "exit_message", "created_at"
                 FROM "batch_step_execution" WHERE "id" = ${stepExecutionId} LIMIT 1`,
    );
    return s.length > 0 ? mapStepExecution(s[0]!) : null;
  }

  override async findStepExecutions(jobExecutionId: string): Promise<StepExecution[]> {
    const rows = await this.prisma.$queryRaw<StepExecutionRow[]>(
      Prisma.sql`SELECT "id", "job_execution_id", "step_name", "status",
                        "read_count", "write_count", "skip_count", "rollback_count", "commit_count",
                        "exit_code", "exit_message", "created_at"
                 FROM "batch_step_execution"
                 WHERE "job_execution_id" = ${jobExecutionId}
                 ORDER BY "created_at" ASC, "id" ASC`,
    );
    return rows.map(mapStepExecution);
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = await this.prisma.$queryRaw<StepExecutionRow[]>(
      Prisma.sql`SELECT "id", "job_execution_id", "step_name", "status",
                        "read_count", "write_count", "skip_count", "rollback_count", "commit_count",
                        "exit_code", "exit_message", "created_at"
                 FROM "batch_step_execution"
                 WHERE "job_execution_id" = ${jobExecutionId} AND "step_name" = ${stepName}
                 ORDER BY "created_at" DESC, "id" DESC
                 LIMIT 1`,
    );
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const jobExecutionId = key.slice(5);
      const e = await this.prisma.$queryRaw<ContextRow[]>(
        Prisma.sql`SELECT "data", "version" FROM "batch_job_execution_context"
                   WHERE "job_execution_id" = ${jobExecutionId} LIMIT 1`,
      );
      if (e.length > 0) {
        return {
          data: e[0]!.data.length > 0 ? deserializeContext(e[0]!.data) : null,
          version: e[0]!.version,
        };
      }
    } else {
      const stepExecutionId = key.slice(6);
      const e = await this.prisma.$queryRaw<ContextRow[]>(
        Prisma.sql`SELECT "data", "version" FROM "batch_step_execution_context"
                   WHERE "step_execution_id" = ${stepExecutionId} LIMIT 1`,
      );
      if (e.length > 0) {
        return {
          data: e[0]!.data.length > 0 ? deserializeContext(e[0]!.data) : null,
          version: e[0]!.version,
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
      const existing = await this.prisma.$queryRaw<ContextRow[]>(
        Prisma.sql`SELECT "version" FROM "batch_job_execution_context"
                   WHERE "job_execution_id" = ${jobExecutionId} LIMIT 1`,
      );
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 1;
      if (existing.length > 0) {
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE "batch_job_execution_context"
                     SET "data" = ${serialized}, "version" = ${nextVersion}
                     WHERE "job_execution_id" = ${jobExecutionId}`,
        );
      } else {
        await this.prisma.$executeRaw(
          Prisma.sql`INSERT INTO "batch_job_execution_context" ("job_execution_id", "data", "version")
                     VALUES (${jobExecutionId}, ${serialized}, ${nextVersion})`,
        );
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.prisma.$queryRaw<ContextRow[]>(
        Prisma.sql`SELECT "version" FROM "batch_step_execution_context"
                   WHERE "step_execution_id" = ${stepExecutionId} LIMIT 1`,
      );
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 1;
      if (existing.length > 0) {
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE "batch_step_execution_context"
                     SET "data" = ${serialized}, "version" = ${nextVersion}
                     WHERE "step_execution_id" = ${stepExecutionId}`,
        );
      } else {
        await this.prisma.$executeRaw(
          Prisma.sql`INSERT INTO "batch_step_execution_context" ("step_execution_id", "data", "version")
                     VALUES (${stepExecutionId}, ${serialized}, ${nextVersion})`,
        );
      }
    }
  }
}

// Local row types (mirror the column shape returned by raw SQL).
type JobInstanceRow = {
  id: string;
  job_name: string;
  job_key: string;
  created_at: Date | string;
};

type JobExecutionRow = {
  id: string;
  job_instance_id: string;
  status: string;
  start_time: Date | string | null;
  end_time: Date | string | null;
  exit_code: string;
  exit_message: string;
  params: string;
};

type StepExecutionRow = {
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
  created_at: Date | string;
};

type ContextRow = {
  data: string;
  version: number;
};
