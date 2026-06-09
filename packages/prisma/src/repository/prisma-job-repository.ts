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
} from '@nest-batch/core';
import type { PrismaClient } from '@prisma/client';

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
  jobName: string;
  jobKey: string;
  createdAt: Date;
}): JobInstance {
  return {
    id: e.id,
    jobName: e.jobName,
    jobKey: e.jobKey,
    createdAt: e.createdAt,
  };
}

function mapJobExecution(e: {
  id: string;
  jobInstanceId: string;
  status: string;
  startTime: Date | null;
  endTime: Date | null;
  exitCode: string;
  exitMessage: string;
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
    jobInstanceId: e.jobInstanceId,
    status: e.status as JobStatus,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    exitCode: e.exitCode,
    exitMessage: e.exitMessage,
    params,
    version: 0,
  };
}
function mapStepExecution(e: {
  id: string;
  jobExecutionId: string;
  stepName: string;
  status: string;
  readCount: number;
  writeCount: number;
  skipCount: number;
  rollbackCount: number;
  commitCount: number;
  exitCode: string;
  exitMessage: string;
}): StepExecution {
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

/**
 * Prisma-backed `JobRepository`.
 *
 * All state lives in the five batch meta tables. The contract
 * guarantees:
 *   - `getOrCreateJobInstance` is race-safe via the (jobName, jobKey)
 *     unique index.
 *   - `createExecutionAtomic` runs inside a single transaction that
 *     (a) idempotently upserts the instance row, (b) acquires a row
 *     lock with `SELECT ... FOR UPDATE SKIP LOCKED`, and (c) rejects
 *     with `JobExecutionAlreadyRunningError` if a STARTING/STARTED
 *     execution already exists.
 *   - `saveExecutionContext` deep-clones the data and auto-increments
 *     the version counter when `version` is omitted.
 *   - `findLatestStepExecution` orders by `created_at` descending.
 */
@Injectable()
export class PrismaJobRepository extends JobRepository {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = await this.prisma.batchJobInstance.findUnique({
      where: { jobName_jobKey: { jobName: name, jobKey } },
    });
    if (existing) return mapJobInstance(existing as unknown as { id: string; job_name: string; job_key: string; created_at: Date });

    const id = randomUUID();
    try {
      const created = await this.prisma.batchJobInstance.create({
        data: { id, jobName: name, jobKey, createdAt: new Date() },
      });
      return mapJobInstance(created as unknown as { id: string; job_name: string; job_key: string; created_at: Date });
    } catch {
      const winner = await this.prisma.batchJobInstance.findUnique({
        where: { jobName_jobKey: { jobName: name, jobKey } },
      });
      if (winner) return mapJobInstance(winner as unknown as { id: string; job_name: string; job_key: string; created_at: Date });
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
  }

  async createJobExecution(
    jobInstanceId: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    const exec = await this.prisma.batchJobExecution.create({
      data: {
        id: randomUUID(),
        jobInstanceId,
        status: JobStatus.STARTING,
        startTime: null,
        endTime: null,
        exitCode: '',
        exitMessage: '',
        params: serializeContext(deepClone(params)),
      },
    });
    return mapJobExecution(exec as unknown as { id: string; job_instance_id: string; status: string; start_time: Date | null; end_time: Date | null; exit_code: string; exit_message: string; params: string });
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Ensure the JobInstance row exists (upsert via raw SQL for ON CONFLICT)
      const instId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT ("job_name", "job_key") DO NOTHING`,
        instId,
        name,
        jobKey,
      );

      // 2. Lock the instance row with SKIP LOCKED
      const locked = await tx.$queryRawUnsafe<
        Array<{ id: string; job_name: string; job_key: string; created_at: Date }>
      >(
        `SELECT "id", "job_name", "job_key", "created_at"
         FROM "batch_job_instance"
         WHERE "job_name" = $1 AND "job_key" = $2
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        name,
        jobKey,
      );
      if (!locked || locked.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = locked[0]!.id;

      // 3. Under the lock, verify no running execution
      const running = await tx.batchJobExecution.findFirst({
        where: {
          jobInstanceId: instanceId,
          status: { in: [JobStatus.STARTING, JobStatus.STARTED] },
        },
      });
      if (running) {
        throw new JobExecutionAlreadyRunningError(running.id);
      }

      // 4. Create the new execution row
      const exec = await tx.batchJobExecution.create({
        data: {
          id: randomUUID(),
          jobInstanceId: instanceId,
          status: JobStatus.STARTING,
          startTime: null,
          endTime: null,
          exitCode: '',
          exitMessage: '',
          params: serializeContext(deepClone(params)),
        },
      });
      return mapJobExecution(exec as unknown as { id: string; job_instance_id: string; status: string; start_time: Date | null; end_time: Date | null; exit_code: string; exit_message: string; params: string });
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.startTime !== undefined) data.startTime = patch.startTime;
    if (patch.endTime !== undefined) data.endTime = patch.endTime;
    if (patch.exitCode !== undefined) data.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) data.exitMessage = patch.exitMessage;
    await this.prisma.batchJobExecution.update({
      where: { id: executionId },
      data,
    });
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const e = await this.prisma.batchJobExecution.findUnique({
      where: { id: executionId },
    });
    return e ? mapJobExecution(e as unknown as { id: string; job_instance_id: string; status: string; start_time: Date | null; end_time: Date | null; exit_code: string; exit_message: string; params: string }) : null;
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const e = await this.prisma.batchJobExecution.findFirst({
      where: {
        jobInstanceId,
        status: { in: [JobStatus.STARTING, JobStatus.STARTED] },
      },
      orderBy: { startTime: 'desc' },
    });
    return e ? mapJobExecution(e as unknown as { id: string; job_instance_id: string; status: string; start_time: Date | null; end_time: Date | null; exit_code: string; exit_message: string; params: string }) : null;
  }

  async createStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution> {
    const step = await this.prisma.batchStepExecution.create({
      data: {
        id: randomUUID(),
        jobExecutionId,
        stepName,
        status: StepStatus.STARTING,
        readCount: 0,
        writeCount: 0,
        skipCount: 0,
        rollbackCount: 0,
        commitCount: 0,
        exitCode: '',
        exitMessage: '',
        createdAt: new Date(),
      },
    });
    return mapStepExecution(step as unknown as { id: string; jobExecutionId: string; stepName: string; status: string; readCount: number; writeCount: number; skipCount: number; rollbackCount: number; commitCount: number; exitCode: string; exitMessage: string });
  }

  async updateStepExecution(
    stepExecutionId: string,
    patch: StepExecutionPatch,
  ): Promise<void> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.readCount !== undefined) data.readCount = patch.readCount;
    if (patch.writeCount !== undefined) data.writeCount = patch.writeCount;
    if (patch.skipCount !== undefined) data.skipCount = patch.skipCount;
    if (patch.rollbackCount !== undefined) data.rollbackCount = patch.rollbackCount;
    if (patch.commitCount !== undefined) data.commitCount = patch.commitCount;
    if (patch.exitCode !== undefined) data.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) data.exitMessage = patch.exitMessage;
    await this.prisma.batchStepExecution.update({
      where: { id: stepExecutionId },
      data,
    });
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const s = await this.prisma.batchStepExecution.findUnique({
      where: { id: stepExecutionId },
    });
    return s ? mapStepExecution(s as unknown as { id: string; jobExecutionId: string; stepName: string; status: string; readCount: number; writeCount: number; skipCount: number; rollbackCount: number; commitCount: number; exitCode: string; exitMessage: string }) : null;
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = await this.prisma.batchStepExecution.findMany({
      where: { jobExecutionId, stepName },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    return rows.length > 0
      ? mapStepExecution(rows[0] as unknown as { id: string; jobExecutionId: string; stepName: string; status: string; readCount: number; writeCount: number; skipCount: number; rollbackCount: number; commitCount: number; exitCode: string; exitMessage: string })
      : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const e = await this.prisma.batchJobExecutionContext.findUnique({
        where: { jobExecutionId: key.slice(5) },
      });
      if (e) {
        return {
          data: e.data.length > 0 ? deserializeContext(e.data) : null,
          version: e.version,
        };
      }
    } else {
      const e = await this.prisma.batchStepExecutionContext.findUnique({
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
      const existing = await this.prisma.batchJobExecutionContext.findUnique({
        where: { jobExecutionId },
      });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        await this.prisma.batchJobExecutionContext.update({
          where: { jobExecutionId },
          data: { data: serialized, version: nextVersion },
        });
      } else {
        await this.prisma.batchJobExecutionContext.create({
          data: { jobExecutionId, data: serialized, version: nextVersion },
        });
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.prisma.batchStepExecutionContext.findUnique({
        where: { stepExecutionId },
      });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        await this.prisma.batchStepExecutionContext.update({
          where: { stepExecutionId },
          data: { data: serialized, version: nextVersion },
        });
      } else {
        await this.prisma.batchStepExecutionContext.create({
          data: { stepExecutionId, data: serialized, version: nextVersion },
        });
      }
    }
  }
}
