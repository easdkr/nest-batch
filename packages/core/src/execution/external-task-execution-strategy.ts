import { Inject, Injectable, Optional } from '@nestjs/common';

import type { JobDefinition } from '../core/ir';
import type { JobParameters } from '../core/repository';

import type {
  ExecutionStrategyContext,
  IExecutionStrategy,
  LaunchResult,
} from './execution-strategy';

export const EXTERNAL_TASK_LAUNCHER: symbol = Symbol.for(
  '@nest-batch/core/EXTERNAL_TASK_LAUNCHER',
);

export const EXTERNAL_TASK_STRATEGY_OPTIONS: symbol = Symbol.for(
  '@nest-batch/core/EXTERNAL_TASK_STRATEGY_OPTIONS',
);

export interface ExternalTaskStrategyOptions {
  readonly workerCommand?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ExternalTaskLaunchRequest {
  readonly jobId: string;
  readonly jobExecutionId: string;
  readonly params: JobParameters;
  readonly workerArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ExternalTaskLaunchResult {
  readonly provider: string;
  readonly externalId: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ExternalTaskLauncher {
  readonly name: string;
  launch(request: ExternalTaskLaunchRequest): Promise<ExternalTaskLaunchResult>;
}

@Injectable()
export class ExternalTaskExecutionStrategy implements IExecutionStrategy {
  readonly name: string;

  constructor(
    @Inject(EXTERNAL_TASK_LAUNCHER)
    private readonly launcher: ExternalTaskLauncher,
    @Optional()
    @Inject(EXTERNAL_TASK_STRATEGY_OPTIONS)
    private readonly options: ExternalTaskStrategyOptions = {},
  ) {
    this.name = launcher.name;
  }

  async launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    const workerArgs = this.buildWorkerArgs(job.id, ctx.jobExecutionId, params);
    const result = await this.launcher.launch({
      jobId: job.id,
      jobExecutionId: ctx.jobExecutionId,
      params,
      workerArgs,
      env: {
        ...(this.options.env ?? {}),
        NEST_BATCH_JOB_ID: job.id,
        NEST_BATCH_JOB_EXECUTION_ID: ctx.jobExecutionId,
      },
      labels: {
        ...(this.options.labels ?? {}),
        'nest-batch/job-id': job.id,
        'nest-batch/job-execution-id': ctx.jobExecutionId,
      },
    });

    return {
      kind: 'enqueued',
      queueJobId: `${result.provider}:${result.externalId}`,
    };
  }

  private buildWorkerArgs(
    jobId: string,
    jobExecutionId: string,
    params: JobParameters,
  ): readonly string[] {
    return [
      ...(this.options.workerCommand ?? ['batch-worker']),
      '--job-id',
      jobId,
      '--job-execution-id',
      jobExecutionId,
      '--params-json',
      JSON.stringify(params),
    ];
  }
}
