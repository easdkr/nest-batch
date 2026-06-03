import type { JobStatus, StepStatus } from '../status';
import type { JsonValue } from '../execution-context/json-value';

export interface JobInstance {
  id: string;
  jobName: string;
  jobKey: string;
  createdAt: Date;
}

export interface JobExecutionPatch {
  status?: JobStatus;
  startTime?: Date | null;
  endTime?: Date | null;
  exitCode?: string;
  exitMessage?: string;
}

export interface JobExecution {
  id: string;
  jobInstanceId: string;
  status: JobStatus;
  startTime: Date | null;
  endTime: Date | null;
  exitCode: string;
  exitMessage: string;
  params: JobParameters;
}

export interface StepExecutionPatch {
  status?: StepStatus;
  readCount?: number;
  writeCount?: number;
  skipCount?: number;
  rollbackCount?: number;
  commitCount?: number;
  startTime?: Date | null;
  endTime?: Date | null;
  exitCode?: string;
  exitMessage?: string;
}

export interface StepExecution {
  id: string;
  jobExecutionId: string;
  stepName: string;
  status: StepStatus;
  readCount: number;
  writeCount: number;
  skipCount: number;
  rollbackCount: number;
  commitCount: number;
  startTime: Date | null;
  endTime: Date | null;
  exitCode: string;
  exitMessage: string;
}

export interface ExecutionContext {
  data: JsonValue;
  version: number;
}

export type ExecutionScope = { jobExecutionId: string } | { stepExecutionId: string };

export type JobParameters = Record<string, JsonValue>;
