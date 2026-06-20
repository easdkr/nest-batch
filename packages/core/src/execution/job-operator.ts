import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { InvalidJobOperationError } from '../core/errors';
import {
  JobExecution,
  JobExecutionDetails,
  JobExecutionFilter,
  JobInstance,
  JobInstanceFilter,
  JobParameters,
  JobRepository,
} from '../core/repository';
import type { JobDefinition } from '../core/ir';
import { JobStatus } from '../core/status';
import { JobRegistry } from '../registry/job-registry';

import { JobExplorer } from './job-explorer';
import { JobLauncher } from './job-launcher';

@Injectable()
export class JobOperator {
  constructor(
    private readonly explorer: JobExplorer,
    private readonly registry: JobRegistry,
    private readonly repository: JobRepository,
    private readonly launcher: JobLauncher,
  ) {}

  listJobs(): JobDefinition[] {
    return this.explorer.listJobs();
  }

  listJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    return this.explorer.listJobInstances(filter);
  }

  listJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    return this.explorer.listJobExecutions(filter);
  }

  getJobExecutionDetails(executionId: string): Promise<JobExecutionDetails> {
    return this.explorer.getJobExecutionDetails(executionId);
  }

  async stop(executionId: string): Promise<JobExecutionDetails> {
    const details = await this.explorer.getJobExecutionDetails(executionId);
    const status = details.jobExecution.status;

    if (status === JobStatus.STOPPED) {
      return details;
    }
    if (!this.isActive(status)) {
      throw new InvalidJobOperationError('stop', `Cannot stop execution in ${status} state`, {
        executionId,
        status,
      });
    }

    await this.repository.updateJobExecution(executionId, {
      status: JobStatus.STOPPED,
      endTime: new Date(),
      exitCode: 'STOPPED',
      exitMessage: 'Stopped by JobOperator',
    });

    return this.explorer.getJobExecutionDetails(executionId);
  }

  async abandon(executionId: string): Promise<JobExecutionDetails> {
    const details = await this.explorer.getJobExecutionDetails(executionId);
    const status = details.jobExecution.status;

    if (status === JobStatus.ABANDONED) {
      return details;
    }
    if (this.isActive(status) || status === JobStatus.COMPLETED) {
      throw new InvalidJobOperationError(
        'abandon',
        `Cannot abandon execution in ${status} state`,
        { executionId, status },
      );
    }

    await this.repository.updateJobExecution(executionId, {
      status: JobStatus.ABANDONED,
      endTime: details.jobExecution.endTime ?? new Date(),
      exitCode: 'ABANDONED',
      exitMessage: 'Abandoned by JobOperator',
    });

    return this.explorer.getJobExecutionDetails(executionId);
  }

  async restart(executionId: string): Promise<JobExecutionDetails> {
    const details = await this.explorer.getJobExecutionDetails(executionId);
    const status = details.jobExecution.status;

    if (status !== JobStatus.FAILED && status !== JobStatus.STOPPED) {
      throw new InvalidJobOperationError(
        'restart',
        `Cannot restart execution in ${status} state`,
        { executionId, status },
      );
    }

    const jobDef = this.registry.get(details.jobInstance.jobName);
    const execution = await this.launcher.run(details.jobExecution, jobDef);
    return this.explorer.getJobExecutionDetails(execution.id);
  }

  startNextInstance(jobId: string, params: JobParameters = {}): Promise<JobExecution> {
    return this.launcher.launch(jobId, {
      ...params,
      _nestBatchRunId: randomUUID(),
    });
  }

  private isActive(status: JobStatus): boolean {
    return (
      status === JobStatus.STARTING ||
      status === JobStatus.STARTED ||
      status === JobStatus.STOPPING
    );
  }
}
