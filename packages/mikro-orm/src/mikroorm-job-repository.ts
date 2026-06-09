import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/core';
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
import {
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from './entities/job-meta.entities';
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

function mapJobInstance(e: JobInstanceEntity): JobInstance {
  return { id: e.id, jobName: e.jobName, jobKey: e.jobKey, createdAt: e.createdAt };
}

function mapJobExecution(e: JobExecutionEntity, overrideParams?: JobParameters): JobExecution {
  let params: JobParameters = {};
  if (overrideParams !== undefined) {
    params = overrideParams;
  } else if (e.params && e.params.length > 0) {
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

@Injectable()
export class MikroORMJobRepository extends JobRepository {
  constructor(
    @Inject(MikroOrmDriverProvider) private readonly em: EntityManager,
  ) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const existing = await em.findOne(JobInstanceEntity, { jobName: name, jobKey });
      if (existing) return mapJobInstance(existing);

      // Use raw SQL INSERT ... ON CONFLICT DO NOTHING RETURNING id
      // so the transaction is not aborted by a unique-constraint
      // violation. If another concurrent caller won the race, the
      // INSERT returns zero rows and we fall back to SELECT.
      const rows = await (em as unknown as { execute: (sql: string, params: unknown[]) => Promise<unknown[]> }).execute(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES (?, ?, ?, now())
         ON CONFLICT ("job_name", "job_key") DO NOTHING
         RETURNING "id", "job_name", "job_key", "created_at"`,
        [randomUUID(), name, jobKey],
      );
      if ((rows as unknown[]).length > 0) {
        const r = (rows as Array<{ id: string; job_name: string; job_key: string; created_at: string }>)[0]!;
        return { id: r.id, jobName: r.job_name, jobKey: r.job_key, createdAt: new Date(r.created_at) };
      }

      const winner = await em.findOne(JobInstanceEntity, { jobName: name, jobKey });
      if (!winner) {
        throw new Error(`JobInstance race lost but no row found for (${name}, ${jobKey})`);
      }
      return mapJobInstance(winner);
    });
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const exec = new JobExecutionEntity();
      exec.id = randomUUID();
      exec.jobInstanceId = jobInstanceId;
      exec.status = JobStatus.STARTING;
      exec.startTime = null;
      exec.endTime = null;
      exec.exitCode = '';
      exec.exitMessage = '';
      exec.params = serializeContext(deepClone(params));
      await em.persistAndFlush(exec);
      return mapJobExecution(exec, deepClone(params));
    });
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.em.transactional(async (em) => {
      await (em as unknown as { execute: (sql: string, params: unknown[]) => Promise<unknown[]> }).execute(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES (?, ?, ?, now())
         ON CONFLICT ("job_name", "job_key") DO NOTHING`,
        [randomUUID(), name, jobKey],
      );
      const rows = await (em as unknown as { execute: (sql: string, params: unknown[]) => Promise<unknown[]> }).execute(
        `SELECT "id" FROM "batch_job_instance"
         WHERE "job_name" = ? AND "job_key" = ?
         FOR UPDATE SKIP LOCKED`,
        [name, jobKey],
      ) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = rows[0]!.id;

      const running = await (em as unknown as { execute: (sql: string, params: unknown[]) => Promise<unknown[]> }).execute(
        `SELECT "id" FROM "batch_job_execution"
         WHERE "job_instance_id" = ? AND "status" IN (?, ?)
         LIMIT 1`,
        [instanceId, JobStatus.STARTING, JobStatus.STARTED],
      ) as Array<{ id: string }>;
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      const exec = new JobExecutionEntity();
      exec.id = randomUUID();
      exec.jobInstanceId = instanceId;
      exec.status = JobStatus.STARTING;
      exec.startTime = null;
      exec.endTime = null;
      exec.exitCode = '';
      exec.exitMessage = '';
      exec.params = serializeContext(deepClone(params));
      await em.persistAndFlush(exec);
      return mapJobExecution(exec, deepClone(params));
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const e = await em.findOne(JobExecutionEntity, { id: executionId });
      if (!e) throw new Error(`JobExecution not found: ${executionId}`);
      if (patch.status !== undefined) e.status = patch.status;
      if (patch.startTime !== undefined) e.startTime = patch.startTime;
      if (patch.endTime !== undefined) e.endTime = patch.endTime;
      if (patch.exitCode !== undefined) e.exitCode = patch.exitCode;
      if (patch.exitMessage !== undefined) e.exitMessage = patch.exitMessage;
      await em.flush();
    });
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const e = await em.findOne(JobExecutionEntity, { id: executionId });
      return e ? mapJobExecution(e) : null;
    });
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const e = await em.findOne(JobExecutionEntity, {
        jobInstanceId,
        status: { $in: [JobStatus.STARTING, JobStatus.STARTED] },
      });
      return e ? mapJobExecution(e) : null;
    });
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
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
      await em.persistAndFlush(step);
      return mapStepExecution(step);
    });
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const s = await em.findOne(StepExecutionEntity, { id: stepExecutionId });
      if (!s) throw new Error(`StepExecution not found: ${stepExecutionId}`);
      if (patch.status !== undefined) s.status = patch.status;
      if (patch.readCount !== undefined) s.readCount = patch.readCount;
      if (patch.writeCount !== undefined) s.writeCount = patch.writeCount;
      if (patch.skipCount !== undefined) s.skipCount = patch.skipCount;
      if (patch.rollbackCount !== undefined) s.rollbackCount = patch.rollbackCount;
      if (patch.commitCount !== undefined) s.commitCount = patch.commitCount;
      if (patch.exitCode !== undefined) s.exitCode = patch.exitCode;
      if (patch.exitMessage !== undefined) s.exitMessage = patch.exitMessage;
      await em.flush();
    });
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const s = await em.findOne(StepExecutionEntity, { id: stepExecutionId });
      return s ? mapStepExecution(s) : null;
    });
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    // Order by `ctid` (physical row id, monotonic per insert) for
    // PostgreSQL; the primary key is a v4 UUID (random bytes), so
    // `id DESC` does not correspond to insertion order. The
    // existing `batch_step_execution_job_execution_id_index` covers
    // the filter, so this is one index range scan + 1-row read.
    return RequestContext.create(this.em, async () => {
      const em = this.em as unknown as { execute: (sql: string, params: unknown[]) => Promise<unknown[]> };
      const rows = await em.execute(
        `SELECT * FROM "batch_step_execution"
         WHERE "job_execution_id" = ? AND "step_name" = ?
         ORDER BY ctid DESC LIMIT 1`,
        [jobExecutionId, stepName],
      ) as StepExecutionEntity[];
      return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
    });
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    return RequestContext.create(this.em, async () => {
      const em = this.em;
      const key = scopeKey(scope);
      if (key.startsWith('job::')) {
        const e = await em.findOne(JobExecutionContextEntity, { jobExecutionId: key.slice(5) });
        if (e) return { data: deserializeContext(e.data), version: e.version };
      } else {
        const e = await em.findOne(StepExecutionContextEntity, {
          stepExecutionId: key.slice(6),
        });
        if (e) return { data: deserializeContext(e.data), version: e.version };
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
      if (key.startsWith('job::')) {
        const jobExecutionId = key.slice(5);
        const existing = await em.findOne(JobExecutionContextEntity, { jobExecutionId });
        const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
        if (existing) {
          existing.data = serializeContext(ctx.data);
          existing.version = nextVersion;
        } else {
          const e = new JobExecutionContextEntity();
          e.jobExecutionId = jobExecutionId;
          e.data = serializeContext(ctx.data);
          e.version = nextVersion;
          await em.persistAndFlush(e);
          return;
        }
      } else {
        const stepExecutionId = key.slice(6);
        const existing = await em.findOne(StepExecutionContextEntity, { stepExecutionId });
        const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
        if (existing) {
          existing.data = serializeContext(ctx.data);
          existing.version = nextVersion;
        } else {
          const e = new StepExecutionContextEntity();
          e.stepExecutionId = stepExecutionId;
          e.data = serializeContext(ctx.data);
          e.version = nextVersion;
          await em.persistAndFlush(e);
          return;
        }
      }
      await em.flush();
    });
  }
}
