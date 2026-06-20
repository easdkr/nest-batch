import { Injectable } from '@nestjs/common';

import type { JobDefinition } from '../core/ir';
import {
  JobExecutionDetails,
  JobExecutionFilter,
  JobInstance,
  JobInstanceFilter,
  JobExecution,
} from '../core/repository';
import { JobRepository } from '../core/repository';
import {
  JobExecutionNotFoundError,
  JobInstanceNotFoundError,
} from '../core/errors';
import { JobRegistry } from '../registry/job-registry';

@Injectable()
export class JobExplorer {
  constructor(
    private readonly registry: JobRegistry,
    private readonly repository: JobRepository,
  ) {}

  listJobs(): JobDefinition[] {
    return this.registry.getAll();
  }

  async getJobInstance(jobInstanceId: string): Promise<JobInstance> {
    const instance = await this.repository.getJobInstance(jobInstanceId);
    if (instance === null) {
      throw new JobInstanceNotFoundError(jobInstanceId);
    }
    return instance;
  }

  async listJobInstances(filter: JobInstanceFilter = {}): Promise<JobInstance[]> {
    return this.repository.findJobInstances(filter);
  }

  async listJobExecutions(filter: JobExecutionFilter = {}): Promise<JobExecution[]> {
    return this.repository.findJobExecutions(filter);
  }

  async getJobExecutionDetails(executionId: string): Promise<JobExecutionDetails> {
    const jobExecution = await this.repository.getJobExecution(executionId);
    if (jobExecution === null) {
      throw new JobExecutionNotFoundError(executionId);
    }

    const jobInstance = await this.repository.getJobInstance(jobExecution.jobInstanceId);
    if (jobInstance === null) {
      throw new JobInstanceNotFoundError(jobExecution.jobInstanceId);
    }

    const stepExecutions = await this.repository.findStepExecutions(executionId);
    const jobContext = await this.repository.getExecutionContext({ jobExecutionId: executionId });
    const stepContexts = await Promise.all(
      stepExecutions.map(async (step) => ({
        stepExecutionId: step.id,
        context: await this.repository.getExecutionContext({ stepExecutionId: step.id }),
      })),
    );

    return {
      jobInstance,
      jobExecution,
      stepExecutions,
      jobContext,
      stepContexts,
    };
  }
}
