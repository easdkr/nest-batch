import { Injectable } from '@nestjs/common';
import { JobRepository } from '@nest-batch/core';
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
import { JobStatus, StepStatus } from '@nest-batch/core';
import { JobExecutionAlreadyRunningError } from '@nest-batch/core';
import { assertJsonSerializable } from '@nest-batch/core';
import type { IdGenerator } from '../id-generator';
import { UuidIdGenerator } from '../id-generator';

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

interface InMemoryState {
  instances: Map<string, JobInstance>; // key: instanceId
  instancesByKey: Map<string, JobInstance>; // key: `${name}::${jobKey}`
  executions: Map<string, JobExecution>;
  stepExecutions: Map<string, StepExecution>;
  contexts: Map<string, ExecutionContext>; // key: serialized ExecutionScope
}

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

/**
 * In-memory JobRepository with real-repo semantics:
 * - deterministic IDs (configurable via IdGenerator)
 * - deep clone on reads/writes to prevent mutation leaks
 * - async signatures
 * - uniqueness on (jobName, jobKey)
 * - getOrCreateJobInstance / createJobExecution / getRunningJobExecution
 *   share a single promise-chain lock, so the check-then-create sequence
 *   used by JobLauncher is race-safe
 *
 * restartable: false by default (per Metis directive: in-memory repo is non-restartable
 * because contexts are lost on process restart).
 */
@Injectable()
export class InMemoryJobRepository extends JobRepository {
  private readonly state: InMemoryState = {
    instances: new Map(),
    instancesByKey: new Map(),
    executions: new Map(),
    stepExecutions: new Map(),
    contexts: new Map(),
  };
  /** Promise-chain lock to serialize getOrCreateJobInstance calls. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly idGen: IdGenerator = new UuidIdGenerator()) {
    super();
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    return this.withLock(async () => {
      const key = `${name}::${jobKey}`;
      const existing = this.state.instancesByKey.get(key);
      if (existing) return deepClone(existing);
      const inst: JobInstance = {
        id: this.idGen.next(),
        jobName: name,
        jobKey,
        createdAt: new Date(),
      };
      this.state.instances.set(inst.id, inst);
      this.state.instancesByKey.set(key, inst);
      return deepClone(inst);
    });
  }

  async createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution> {
    return this.withLock(async () => {
      const exec: JobExecution = {
        id: this.idGen.next(),
        jobInstanceId,
        status: JobStatus.STARTING,
        startTime: null,
        endTime: null,
        exitCode: '',
        exitMessage: '',
        params: deepClone(params),
      };
      this.state.executions.set(exec.id, exec);
      return deepClone(exec);
    });
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.withLock(async () => {
      const key = `${name}::${jobKey}`;
      let instance = this.state.instancesByKey.get(key);
      if (!instance) {
        instance = {
          id: this.idGen.next(),
          jobName: name,
          jobKey,
          createdAt: new Date(),
        };
        this.state.instances.set(instance.id, instance);
        this.state.instancesByKey.set(key, instance);
      }
      for (const exec of this.state.executions.values()) {
        if (
          exec.jobInstanceId === instance.id &&
          (exec.status === JobStatus.STARTING || exec.status === JobStatus.STARTED)
        ) {
          throw new JobExecutionAlreadyRunningError(exec.id);
        }
      }
      const exec: JobExecution = {
        id: this.idGen.next(),
        jobInstanceId: instance.id,
        status: JobStatus.STARTING,
        startTime: null,
        endTime: null,
        exitCode: '',
        exitMessage: '',
        params: deepClone(params),
      };
      this.state.executions.set(exec.id, exec);
      return deepClone(exec);
    });
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    return this.withLock(async () => {
      for (const exec of this.state.executions.values()) {
        if (
          exec.jobInstanceId === jobInstanceId &&
          (exec.status === JobStatus.STARTING || exec.status === JobStatus.STARTED)
        ) {
          return deepClone(exec);
        }
      }
      return null;
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const cur = this.state.executions.get(executionId);
    if (!cur) throw new Error(`JobExecution not found: ${executionId}`);
    const next: JobExecution = {
      ...cur,
      ...patch,
      startTime: patch.startTime === undefined ? cur.startTime : patch.startTime,
      endTime: patch.endTime === undefined ? cur.endTime : patch.endTime,
    };
    this.state.executions.set(executionId, next);
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const e = this.state.executions.get(executionId);
    return e ? deepClone(e) : null;
  }

  override async getJobInstance(jobInstanceId: string): Promise<JobInstance | null> {
    const instance = this.state.instances.get(jobInstanceId);
    return instance ? deepClone(instance) : null;
  }

  override async findJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    const rows: JobInstance[] = [];
    for (const instance of this.state.instances.values()) {
      if (filter.jobName !== undefined && instance.jobName !== filter.jobName) continue;
      if (filter.jobKey !== undefined && instance.jobKey !== filter.jobKey) continue;
      rows.push(deepClone(instance));
    }
    return rows;
  }

  override async findJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    let statuses: Set<JobStatus> | undefined;
    if (filter.status !== undefined) {
      const statusFilter = filter.status;
      const statusList: readonly JobStatus[] = Array.isArray(statusFilter)
        ? statusFilter
        : [statusFilter];
      statuses = new Set<JobStatus>(statusList);
    }

    const rows: JobExecution[] = [];
    for (const execution of this.state.executions.values()) {
      if (
        filter.jobInstanceId !== undefined &&
        execution.jobInstanceId !== filter.jobInstanceId
      ) {
        continue;
      }
      if (statuses !== undefined && !statuses.has(execution.status)) continue;
      if (
        filter.startedAfter !== undefined &&
        (execution.startTime === null || execution.startTime < filter.startedAfter)
      ) {
        continue;
      }
      if (
        filter.startedBefore !== undefined &&
        (execution.startTime === null || execution.startTime > filter.startedBefore)
      ) {
        continue;
      }
      rows.push(deepClone(execution));
    }
    return rows;
  }

  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    const step: StepExecution = {
      id: this.idGen.next(),
      jobExecutionId,
      stepName,
      status: StepStatus.STARTING,
      readCount: 0,
      writeCount: 0,
      skipCount: 0,
      rollbackCount: 0,
      commitCount: 0,
      startTime: null,
      endTime: null,
      exitCode: '',
      exitMessage: '',
    };
    this.state.stepExecutions.set(step.id, step);
    return deepClone(step);
  }

  async updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void> {
    const cur = this.state.stepExecutions.get(stepExecutionId);
    if (!cur) throw new Error(`StepExecution not found: ${stepExecutionId}`);
    const next: StepExecution = { ...cur, ...patch };
    this.state.stepExecutions.set(stepExecutionId, next);
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const s = this.state.stepExecutions.get(stepExecutionId);
    return s ? deepClone(s) : null;
  }

  override async findStepExecutions(jobExecutionId: string): Promise<StepExecution[]> {
    const rows: StepExecution[] = [];
    for (const step of this.state.stepExecutions.values()) {
      if (step.jobExecutionId === jobExecutionId) {
        rows.push(deepClone(step));
      }
    }
    return rows;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const ctx = this.state.contexts.get(scopeKey(scope));
    if (ctx) return { data: deepClone(ctx.data), version: ctx.version };
    return { data: null, version: 0 };
  }

  async saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void> {
    // Validate JSON-serializability (per ExecutionContext contract)
    assertJsonSerializable(ctx.data);
    const current = this.state.contexts.get(scopeKey(scope));
    const nextVersion = version !== undefined ? version : (current?.version ?? 0) + 1;
    this.state.contexts.set(scopeKey(scope), {
      data: deepClone(ctx.data),
      version: nextVersion,
    });
  }

  /**
   * Returns the most recently created StepExecution for the given
   * (jobExecutionId, stepName) pair, or `null` if none exists. Insertion
   * order over `Map` is stable (ES2015+), so a reverse scan picks the
   * latest entry that matches the filter. The restart path filters the
   * result further by status (FAILED) at the call site.
   */
  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    let latest: StepExecution | null = null;
    for (const step of this.state.stepExecutions.values()) {
      if (step.jobExecutionId === jobExecutionId && step.stepName === stepName) {
        if (!latest) {
          latest = step;
        }
        // No monotonic timestamp on StepExecution itself; rely on Map
        // insertion order: later-created entries override earlier ones.
        latest = step;
      }
    }
    return latest ? deepClone(latest) : null;
  }
}

export const RESTARTABLE_DEFAULT_INMEMORY = false;
