import { Inject, Injectable } from '@nestjs/common';
import type {
  ExternalTaskLauncher,
  ExternalTaskLaunchRequest,
  ExternalTaskLaunchResult,
} from '@nest-batch/core';

import {
  AWS_BATCH_MODULE_OPTIONS,
  type AwsBatchSubmitJobInput,
  type ResolvedAwsBatchModuleOptions,
} from './module-options';

export const AWS_BATCH_STRATEGY_NAME = 'aws-batch';

@Injectable()
export class AwsBatchJobLauncher implements ExternalTaskLauncher {
  readonly name = AWS_BATCH_STRATEGY_NAME;

  constructor(
    @Inject(AWS_BATCH_MODULE_OPTIONS)
    private readonly options: ResolvedAwsBatchModuleOptions,
  ) {}

  async launch(request: ExternalTaskLaunchRequest): Promise<ExternalTaskLaunchResult> {
    const input = this.buildSubmitJobInput(request);
    const output = await this.options.client.submitJob(input);
    if (output.jobId === undefined || output.jobId.length === 0) {
      throw new Error('AWS Batch SubmitJob did not return a jobId');
    }
    return {
      provider: this.name,
      externalId: output.jobId,
      metadata: {
        jobName: output.jobName ?? input.jobName,
        jobQueue: this.options.jobQueue,
        jobDefinition: this.options.jobDefinition,
      },
    };
  }

  buildSubmitJobInput(request: ExternalTaskLaunchRequest): AwsBatchSubmitJobInput {
    return {
      jobName: this.buildJobName(request.jobExecutionId),
      jobQueue: this.options.jobQueue,
      jobDefinition: this.options.jobDefinition,
      parameters: {
        ...this.options.parameters,
        jobId: request.jobId,
        jobExecutionId: request.jobExecutionId,
      },
      containerOverrides: {
        command: [...request.workerArgs],
        environment: Object.entries(request.env).map(([name, value]) => ({
          name,
          value,
        })),
      },
      ...(this.options.arrayProperties !== undefined
        ? { arrayProperties: this.options.arrayProperties }
        : {}),
      ...(this.options.retryStrategy !== undefined
        ? { retryStrategy: this.options.retryStrategy }
        : {}),
      ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
      tags: {
        ...this.options.tags,
        ...request.labels,
      },
    };
  }

  private buildJobName(jobExecutionId: string): string {
    const suffix = jobExecutionId.replace(/[^A-Za-z0-9_-]/g, '-');
    return `${this.options.jobNamePrefix}-${suffix}`.slice(0, 128);
  }
}
