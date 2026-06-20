import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  InvalidJobOperationError,
  JobExecutionNotFoundError,
  JobInstanceNotFoundError,
} from '../core/errors';
import type { JobParameters, JobExecution } from '../core/repository';
import { JobRepository } from '../core/repository';
import { JobStatus } from '../core/status';
import { JobRegistry } from '../registry/job-registry';

import { JobExecutor } from './job-executor';
import { canonicalJobKey } from './job-key';

export interface BatchWorkerRunOptions {
  readonly jobExecutionId?: string;
  readonly executionId?: string;
  readonly jobId?: string;
  readonly params?: JobParameters;
  readonly partitionIndex?: number;
  readonly partitionCount?: number;
}

export interface BatchWorkerRunResult {
  readonly jobExecution: JobExecution;
  readonly status: JobStatus;
  readonly processExitCode: number;
}

@Injectable()
export class BatchWorkerRunner {
  constructor(
    private readonly registry: JobRegistry,
    private readonly repository: JobRepository,
    private readonly jobExecutor: JobExecutor,
  ) {}

  async run(options: BatchWorkerRunOptions): Promise<BatchWorkerRunResult> {
    const executionId = options.jobExecutionId ?? options.executionId;
    const params = options.params ?? {};

    let jobId = options.jobId;
    let execution: JobExecution;

    if (executionId !== undefined) {
      const existing = await this.repository.getJobExecution(executionId);
      if (existing === null) {
        throw new JobExecutionNotFoundError(executionId);
      }
      execution = existing;
      if (jobId === undefined) {
        const instance = await this.repository.getJobInstance(existing.jobInstanceId);
        if (instance === null) {
          throw new JobInstanceNotFoundError(existing.jobInstanceId);
        }
        jobId = instance.jobName;
      }
    } else {
      if (jobId === undefined) {
        throw new InvalidJobOperationError(
          'worker-run',
          'BatchWorkerRunner requires either jobExecutionId or jobId',
        );
      }
      const jobDef = this.registry.get(jobId);
      const canonical = canonicalJobKey(params);
      const jobKey = jobDef.allowDuplicateInstances
        ? `${canonical}::${randomUUID()}`
        : canonical;
      execution = await this.repository.createExecutionAtomic(jobId, jobKey, params);
    }

    const jobDef = this.registry.get(jobId);
    const jobExecution = await this.jobExecutor.execute(execution, jobDef, {
      ...(options.partitionIndex !== undefined
        ? { partitionIndex: options.partitionIndex }
        : {}),
      ...(options.partitionCount !== undefined
        ? { partitionCount: options.partitionCount }
        : {}),
    });

    return {
      jobExecution,
      status: jobExecution.status,
      processExitCode: jobExecution.status === JobStatus.COMPLETED ? 0 : 1,
    };
  }
}

export function parseBatchWorkerArgs(argv: readonly string[]): BatchWorkerRunOptions {
  const args = argv[0] === 'batch-worker' ? argv.slice(1) : argv;
  const out: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }

  let params: JobParameters | undefined;
  if (out['params-json'] !== undefined) {
    const parsed = JSON.parse(out['params-json']) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidJobOperationError(
        'worker-args',
        '--params-json must be a JSON object',
      );
    }
    params = parsed as JobParameters;
  }

  return {
    ...(out['execution-id'] !== undefined ? { jobExecutionId: out['execution-id'] } : {}),
    ...(out['job-execution-id'] !== undefined
      ? { jobExecutionId: out['job-execution-id'] }
      : {}),
    ...(out['job-id'] !== undefined ? { jobId: out['job-id'] } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(out['partition-index'] !== undefined
      ? { partitionIndex: Number(out['partition-index']) }
      : {}),
    ...(out['partition-count'] !== undefined
      ? { partitionCount: Number(out['partition-count']) }
      : {}),
  };
}
