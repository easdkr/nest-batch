import type {
  JobInstance,
  JobExecution,
  JobExecutionPatch,
  JobParameters,
  StepExecution,
  StepExecutionPatch,
  ExecutionContext,
  ExecutionScope,
} from './types';

export interface IJobRepository {
  getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance>;
  createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution>;
  /**
   * Atomically: ensure a `JobInstance` for `(name, jobKey)` exists, lock
   * the instance row (skipping if another concurrent launch already
   * holds the lock), verify no running execution, and create a new
   * execution in STARTING state. The PostgreSQL implementation uses
   * `INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE SKIP
   * LOCKED` inside a single transaction. The in-memory implementation
   * uses an in-process mutex (Node is single-threaded so the lock is
   * effectively a serialization point rather than a true blocker).
   *
   * Throws `JobExecutionAlreadyRunningError` if another launch is in
   * progress (FOR UPDATE returned no row) or if an execution is already
   * STARTING/STARTED for this instance.
   */
  createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution>;
  updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void>;
  getJobExecution(executionId: string): Promise<JobExecution | null>;
  getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null>;
  createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution>;
  updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void>;
  getStepExecution(stepExecutionId: string): Promise<StepExecution | null>;
  getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext>;
  saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void>;
  /**
   * Find the most recently created StepExecution for a given
   * (jobExecutionId, stepName) pair regardless of status. Returns `null`
   * if no matching step execution exists. Used by the restart path to
   * locate the prior (typically FAILED) step execution so its execution
   * context — which holds the last-committed-chunk checkpoint — can be
   * loaded.
   */
  findLatestStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution | null>;
}

export abstract class JobRepository implements IJobRepository {
  abstract getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance>;
  abstract createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution>;
  abstract createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution>;
  abstract updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void>;
  abstract getJobExecution(executionId: string): Promise<JobExecution | null>;
  abstract getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null>;
  abstract createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution>;
  abstract updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void>;
  abstract getStepExecution(stepExecutionId: string): Promise<StepExecution | null>;
  abstract getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext>;
  abstract saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void>;
  abstract findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null>;
}
