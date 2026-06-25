import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
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
import { PrismaDriverProvider } from '../prisma.driver-provider';

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
 * Prisma-backed `JobRepository`.
 *
 * The package is driver-agnostic: the actual `PrismaClient` is
 * provided by the `@nest-batch/postgresql` (or future
 * `@nest-batch/mysql`) driver sibling via the `PrismaDriverProvider`
 * token. The repository uses raw SQL via `prisma.$queryRaw` /
 * `prisma.$executeRaw` so it does NOT depend on Prisma's generated
 * client model names. The host's app-owned Prisma schema must still
 * create the documented batch meta tables.
 */
@Injectable()
export class PrismaJobRepository extends JobRepository {
  constructor(@Inject(PrismaDriverProvider) private readonly prisma: PrismaClient) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = (await this.prisma.$queryRaw`
      SELECT "id", "job_name", "job_key", "created_at"
      FROM "batch_job_instance"
      WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
      LIMIT 1
    `) as JobInstanceRow[];
    if (existing.length > 0) return mapJobInstance(existing[0]!);

    const id = randomUUID();
    try {
      const inserted = (await this.prisma.$queryRaw`
        INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
        VALUES (${id}, ${name}, ${jobKey}, NOW())
        ON CONFLICT ("job_name", "job_key") DO NOTHING
        RETURNING "id", "job_name", "job_key", "created_at"
      `) as JobInstanceRow[];
      if (inserted.length > 0) return mapJobInstance(inserted[0]!);
    } catch {
      // Fall through to read-back.
    }
    const winner = (await this.prisma.$queryRaw`
      SELECT "id", "job_name", "job_key", "created_at"
      FROM "batch_job_instance"
      WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
      LIMIT 1
    `) as JobInstanceRow[];
    if (winner.length === 0) {
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
    return mapJobInstance(winner[0]!);
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    const execId = randomUUID();
    const execParams = serializeContext(deepClone(params));
    const rows = (await this.prisma.$queryRaw`
      INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
      VALUES (${execId}, ${jobInstanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
      RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
    `) as JobExecutionRow[];
    return mapJobExecution(rows[0]!);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Idempotent INSERT.
      const instId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
        VALUES (${instId}, ${name}, ${jobKey}, NOW())
        ON CONFLICT ("job_name", "job_key") DO NOTHING
      `;

      // 2. Lock the instance row with FOR UPDATE SKIP LOCKED.
      const locked = (await tx.$queryRaw`
        SELECT "id", "job_name", "job_key", "created_at"
        FROM "batch_job_instance"
        WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `) as Array<{ id: string }>;
      if (!locked || locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      // 3. Under the lock, verify no running execution.
      const running = (await tx.$queryRaw`
        SELECT "id" FROM "batch_job_execution"
        WHERE "job_instance_id" = ${instanceId}
          AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
        LIMIT 1
      `) as Array<{ id: string }>;
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const execId = randomUUID();
      const execParams = serializeContext(deepClone(params));
      const inserted = (await tx.$queryRaw`
        INSERT INTO "batch_job_execution" ("id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params")
        VALUES (${execId}, ${instanceId}, ${JobStatus.STARTING}, NULL, NULL, '', '', ${execParams})
        RETURNING "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
      `) as JobExecutionRow[];
      return mapJobExecution(inserted[0]!);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    if (patch.status !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_job_execution" SET "status" = ${patch.status} WHERE "id" = ${executionId}`;
    }
    if (patch.startTime !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_job_execution" SET "start_time" = ${patch.startTime} WHERE "id" = ${executionId}`;
    }
    if (patch.endTime !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_job_execution" SET "end_time" = ${patch.endTime} WHERE "id" = ${executionId}`;
    }
    if (patch.exitCode !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_job_execution" SET "exit_code" = ${patch.exitCode} WHERE "id" = ${executionId}`;
    }
    if (patch.exitMessage !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_job_execution" SET "exit_message" = ${patch.exitMessage} WHERE "id" = ${executionId}`;
    }
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
      FROM "batch_job_execution" WHERE "id" = ${executionId} LIMIT 1
    `) as JobExecutionRow[];
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  override async getJobInstance(jobInstanceId: string): Promise<JobInstance | null> {
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_name", "job_key", "created_at"
      FROM "batch_job_instance"
      WHERE "id" = ${jobInstanceId}
      LIMIT 1
    `) as JobInstanceRow[];
    return rows.length > 0 ? mapJobInstance(rows[0]!) : null;
  }

  override async findJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    const rows =
      filter.jobName !== undefined && filter.jobKey !== undefined
        ? ((await this.prisma.$queryRaw`
          SELECT "id", "job_name", "job_key", "created_at"
          FROM "batch_job_instance"
          WHERE "job_name" = ${filter.jobName} AND "job_key" = ${filter.jobKey}
          ORDER BY "created_at" ASC, "id" ASC
        `) as JobInstanceRow[])
        : filter.jobName !== undefined
          ? ((await this.prisma.$queryRaw`
            SELECT "id", "job_name", "job_key", "created_at"
            FROM "batch_job_instance"
            WHERE "job_name" = ${filter.jobName}
            ORDER BY "created_at" ASC, "id" ASC
          `) as JobInstanceRow[])
          : filter.jobKey !== undefined
            ? ((await this.prisma.$queryRaw`
              SELECT "id", "job_name", "job_key", "created_at"
              FROM "batch_job_instance"
              WHERE "job_key" = ${filter.jobKey}
              ORDER BY "created_at" ASC, "id" ASC
            `) as JobInstanceRow[])
            : ((await this.prisma.$queryRaw`
              SELECT "id", "job_name", "job_key", "created_at"
              FROM "batch_job_instance"
              ORDER BY "created_at" ASC, "id" ASC
            `) as JobInstanceRow[]);
    return rows.map(mapJobInstance);
  }

  override async findJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    const allRows = (await this.prisma.$queryRaw`
      SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
      FROM "batch_job_execution"
      ORDER BY "start_time" DESC NULLS LAST, "id" DESC
    `) as JobExecutionRow[];
    const statuses =
      filter.status === undefined
        ? undefined
        : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    return allRows
      .filter(
        (row) => filter.jobInstanceId === undefined || row.job_instance_id === filter.jobInstanceId,
      )
      .filter((row) => statuses === undefined || statuses.has(row.status as JobStatus))
      .filter((row) => {
        const startTime =
          row.start_time instanceof Date
            ? row.start_time
            : row.start_time
              ? new Date(row.start_time)
              : null;
        if (
          filter.startedAfter !== undefined &&
          (startTime === null || startTime < filter.startedAfter)
        )
          return false;
        if (
          filter.startedBefore !== undefined &&
          (startTime === null || startTime > filter.startedBefore)
        )
          return false;
        return true;
      })
      .map(mapJobExecution);
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_instance_id", "status", "start_time", "end_time", "exit_code", "exit_message", "params"
      FROM "batch_job_execution"
      WHERE "job_instance_id" = ${jobInstanceId}
        AND "status" IN (${JobStatus.STARTING}, ${JobStatus.STARTED})
      ORDER BY "start_time" DESC NULLS LAST
      LIMIT 1
    `) as JobExecutionRow[];
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    const stepId = randomUUID();
    const rows = (await this.prisma.$queryRaw`
      INSERT INTO "batch_step_execution" ("id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at")
      VALUES (${stepId}, ${jobExecutionId}, ${stepName}, ${StepStatus.STARTING}, 0, 0, 0, 0, 0, '', '', NOW())
      RETURNING "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
    `) as StepExecutionRow[];
    return mapStepExecution(rows[0]!);
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    if (patch.status !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "status" = ${patch.status} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.readCount !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "read_count" = ${patch.readCount} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.writeCount !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "write_count" = ${patch.writeCount} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.skipCount !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "skip_count" = ${patch.skipCount} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.rollbackCount !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "rollback_count" = ${patch.rollbackCount} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.commitCount !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "commit_count" = ${patch.commitCount} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.exitCode !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "exit_code" = ${patch.exitCode} WHERE "id" = ${stepExecutionId}`;
    }
    if (patch.exitMessage !== undefined) {
      await this.prisma
        .$executeRaw`UPDATE "batch_step_execution" SET "exit_message" = ${patch.exitMessage} WHERE "id" = ${stepExecutionId}`;
    }
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
      FROM "batch_step_execution" WHERE "id" = ${stepExecutionId} LIMIT 1
    `) as StepExecutionRow[];
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  override async findStepExecutions(jobExecutionId: string): Promise<StepExecution[]> {
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
      FROM "batch_step_execution"
      WHERE "job_execution_id" = ${jobExecutionId}
      ORDER BY "created_at" ASC, "id" ASC
    `) as StepExecutionRow[];
    return rows.map(mapStepExecution);
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = (await this.prisma.$queryRaw`
      SELECT "id", "job_execution_id", "step_name", "status", "read_count", "write_count", "skip_count", "rollback_count", "commit_count", "exit_code", "exit_message", "created_at"
      FROM "batch_step_execution"
      WHERE "job_execution_id" = ${jobExecutionId} AND "step_name" = ${stepName}
      ORDER BY "created_at" DESC, "id" DESC
      LIMIT 1
    `) as StepExecutionRow[];
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const rows = (await this.prisma.$queryRaw`
        SELECT "data", "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ${key.slice(5)} LIMIT 1
      `) as ContextRow[];
      if (rows.length > 0) {
        return {
          data: rows[0]!.data.length > 0 ? deserializeContext(rows[0]!.data) : null,
          version: rows[0]!.version,
        };
      }
    } else {
      const rows = (await this.prisma.$queryRaw`
        SELECT "data", "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ${key.slice(6)} LIMIT 1
      `) as ContextRow[];
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
      const existing = (await this.prisma.$queryRaw`
        SELECT "version" FROM "batch_job_execution_context" WHERE "job_execution_id" = ${jobExecutionId} LIMIT 1
      `) as ContextRow[];
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 0;
      if (existing.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "batch_job_execution_context" SET "data" = ${serialized}, "version" = ${nextVersion} WHERE "job_execution_id" = ${jobExecutionId}
        `;
      } else {
        await this.prisma.$executeRaw`
          INSERT INTO "batch_job_execution_context" ("job_execution_id", "data", "version") VALUES (${jobExecutionId}, ${serialized}, ${nextVersion})
        `;
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = (await this.prisma.$queryRaw`
        SELECT "version" FROM "batch_step_execution_context" WHERE "step_execution_id" = ${stepExecutionId} LIMIT 1
      `) as ContextRow[];
      const nextVersion =
        version !== undefined ? version : existing.length > 0 ? existing[0]!.version + 1 : 0;
      if (existing.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE "batch_step_execution_context" SET "data" = ${serialized}, "version" = ${nextVersion} WHERE "step_execution_id" = ${stepExecutionId}
        `;
      } else {
        await this.prisma.$executeRaw`
          INSERT INTO "batch_step_execution_context" ("step_execution_id", "data", "version") VALUES (${stepExecutionId}, ${serialized}, ${nextVersion})
        `;
      }
    }
  }
}
