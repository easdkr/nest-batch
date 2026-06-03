import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
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
import {
  JobInstanceEntity,
  JobExecutionEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from '../../entities/job-meta.entities';
import { randomUUID } from 'crypto';

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

function mapJobInstance(e: JobInstanceEntity): JobInstance {
  return { id: e.id, jobName: e.jobName, jobKey: e.jobKey, createdAt: e.createdAt };
}

function mapJobExecution(e: JobExecutionEntity, params: JobParameters = {}): JobExecution {
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
  constructor(private readonly em: EntityManager) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    let existing = await this.em.findOne(JobInstanceEntity, { jobName: name, jobKey });
    if (existing) return mapJobInstance(existing);
    const inst = new JobInstanceEntity();
    inst.id = randomUUID();
    inst.jobName = name;
    inst.jobKey = jobKey;
    inst.createdAt = new Date();
    await this.em.persistAndFlush(inst);
    return mapJobInstance(inst);
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    const exec = new JobExecutionEntity();
    exec.id = randomUUID();
    exec.jobInstanceId = jobInstanceId;
    exec.status = JobStatus.STARTING;
    exec.startTime = null;
    exec.endTime = null;
    exec.exitCode = '';
    exec.exitMessage = '';
    await this.em.persistAndFlush(exec);
    return mapJobExecution(exec, params);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    // Run the entire check-then-create sequence inside a single
    // transaction. The instance row is locked with FOR UPDATE SKIP
    // LOCKED, so a concurrent launch for the same (name, jobKey) sees
    // 0 rows and aborts cleanly. The lock is held until the
    // transaction commits, which is when control returns to the
    // caller; the executor itself runs OUTSIDE this lock.
    return this.em.transactional(async (em) => {
      // 1. Ensure the JobInstance row exists. INSERT ... ON CONFLICT
      // DO NOTHING is idempotent: if another transaction created the
      // row first, this is a no-op and we proceed to lock the
      // existing row.
      await em.execute(
        `INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
         VALUES (?, ?, ?, now())
         ON CONFLICT ("job_name", "job_key") DO NOTHING`,
        [randomUUID(), name, jobKey],
      );

      // 2. Lock the instance row. SKIP LOCKED means: if another
      // concurrent launch already holds the lock, this returns 0
      // rows and we treat that as "another launch in progress".
      const rows = await em.execute(
        `SELECT "id" FROM "batch_job_instance"
         WHERE "job_name" = ? AND "job_key" = ?
         FOR UPDATE SKIP LOCKED`,
        [name, jobKey],
      );
      if (rows.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = (rows[0] as { id: string }).id;

      // 3. Under the lock, verify no running execution.
      const running = await em.findOne(
        JobExecutionEntity,
        {
          jobInstanceId: instanceId,
          status: { $in: [JobStatus.STARTING, JobStatus.STARTED] },
        },
      );
      if (running) {
        throw new JobExecutionAlreadyRunningError(running.id);
      }

      // 4. Create the new execution row. Because we hold the row
      // lock on JobInstance, no other launch can create a competing
      // execution for the same instance until this TX commits.
      const exec = new JobExecutionEntity();
      exec.id = randomUUID();
      exec.jobInstanceId = instanceId;
      exec.status = JobStatus.STARTING;
      exec.startTime = null;
      exec.endTime = null;
      exec.exitCode = '';
      exec.exitMessage = '';
      await em.persistAndFlush(exec);
      return mapJobExecution(exec, params);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const e = await this.em.findOne(JobExecutionEntity, { id: executionId });
    if (!e) throw new Error(`JobExecution not found: ${executionId}`);
    if (patch.status !== undefined) e.status = patch.status;
    if (patch.startTime !== undefined) e.startTime = patch.startTime;
    if (patch.endTime !== undefined) e.endTime = patch.endTime;
    if (patch.exitCode !== undefined) e.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) e.exitMessage = patch.exitMessage;
    await this.em.flush();
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const e = await this.em.findOne(JobExecutionEntity, { id: executionId });
    return e ? mapJobExecution(e) : null;
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    const e = await this.em.findOne(
      JobExecutionEntity,
      {
        jobInstanceId,
        status: { $in: [JobStatus.STARTING, JobStatus.STARTED] },
      },
      { orderBy: { startTime: 'DESC' } },
    );
    return e ? mapJobExecution(e) : null;
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
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
    await this.em.persistAndFlush(step);
    return mapStepExecution(step);
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    const s = await this.em.findOne(StepExecutionEntity, { id: stepExecutionId });
    if (!s) throw new Error(`StepExecution not found: ${stepExecutionId}`);
    if (patch.status !== undefined) s.status = patch.status;
    if (patch.readCount !== undefined) s.readCount = patch.readCount;
    if (patch.writeCount !== undefined) s.writeCount = patch.writeCount;
    if (patch.skipCount !== undefined) s.skipCount = patch.skipCount;
    if (patch.rollbackCount !== undefined) s.rollbackCount = patch.rollbackCount;
    if (patch.commitCount !== undefined) s.commitCount = patch.commitCount;
    if (patch.exitCode !== undefined) s.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) s.exitMessage = patch.exitMessage;
    await this.em.flush();
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const s = await this.em.findOne(StepExecutionEntity, { id: stepExecutionId });
    return s ? mapStepExecution(s) : null;
  }

  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    void jobExecutionId;
    void stepName;
    return null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const e = await this.em.findOne(JobExecutionContextEntity, { jobExecutionId: key.slice(5) });
      if (e) return { data: deserializeContext(e.data), version: e.version };
    } else {
      const e = await this.em.findOne(StepExecutionContextEntity, {
        stepExecutionId: key.slice(6),
      });
      if (e) return { data: deserializeContext(e.data), version: e.version };
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
    if (key.startsWith('job::')) {
      const jobExecutionId = key.slice(5);
      const existing = await this.em.findOne(JobExecutionContextEntity, { jobExecutionId });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        existing.data = serializeContext(ctx.data);
        existing.version = nextVersion;
      } else {
        const e = new JobExecutionContextEntity();
        e.jobExecutionId = jobExecutionId;
        e.data = serializeContext(ctx.data);
        e.version = nextVersion;
        await this.em.persistAndFlush(e);
        return;
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.em.findOne(StepExecutionContextEntity, { stepExecutionId });
      const nextVersion = version !== undefined ? version : (existing?.version ?? 0) + 1;
      if (existing) {
        existing.data = serializeContext(ctx.data);
        existing.version = nextVersion;
      } else {
        const e = new StepExecutionContextEntity();
        e.stepExecutionId = stepExecutionId;
        e.data = serializeContext(ctx.data);
        e.version = nextVersion;
        await this.em.persistAndFlush(e);
        return;
      }
    }
    await this.em.flush();
  }
}
