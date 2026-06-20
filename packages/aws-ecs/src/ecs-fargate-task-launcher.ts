import { Inject, Injectable } from '@nestjs/common';
import type {
  ExternalTaskLauncher,
  ExternalTaskLaunchRequest,
  ExternalTaskLaunchResult,
} from '@nest-batch/core';

import {
  ECS_FARGATE_MODULE_OPTIONS,
  type EcsFargateRunTaskInput,
  type EcsFargateTag,
  type ResolvedEcsFargateModuleOptions,
} from './module-options';

export const ECS_FARGATE_STRATEGY_NAME = 'aws-ecs-fargate';

@Injectable()
export class EcsFargateTaskLauncher implements ExternalTaskLauncher {
  readonly name = ECS_FARGATE_STRATEGY_NAME;

  constructor(
    @Inject(ECS_FARGATE_MODULE_OPTIONS)
    private readonly options: ResolvedEcsFargateModuleOptions,
  ) {}

  async launch(request: ExternalTaskLaunchRequest): Promise<ExternalTaskLaunchResult> {
    const input = this.buildRunTaskInput(request);
    const output = await this.options.client.runTask(input);
    const failure = output.failures?.[0];
    if (failure !== undefined) {
      throw new Error(
        `ECS RunTask failed: ${failure.reason ?? 'unknown'}${failure.detail !== undefined ? ` (${failure.detail})` : ''}`,
      );
    }

    const taskArn = output.tasks?.[0]?.taskArn;
    if (taskArn === undefined || taskArn.length === 0) {
      throw new Error('ECS RunTask did not return a taskArn');
    }

    return {
      provider: this.name,
      externalId: taskArn,
      metadata: {
        cluster: this.options.cluster,
        taskDefinition: this.options.taskDefinition,
      },
    };
  }

  buildRunTaskInput(request: ExternalTaskLaunchRequest): EcsFargateRunTaskInput {
    return {
      cluster: this.options.cluster,
      taskDefinition: this.options.taskDefinition,
      launchType: 'FARGATE',
      ...(this.options.platformVersion !== undefined
        ? { platformVersion: this.options.platformVersion }
        : {}),
      ...(this.options.startedBy !== undefined ? { startedBy: this.options.startedBy } : {}),
      enableExecuteCommand: this.options.enableExecuteCommand,
      networkConfiguration: {
        awsvpcConfiguration: this.options.networkConfiguration,
      },
      overrides: {
        containerOverrides: [
          {
            name: this.options.containerName,
            command: [...request.workerArgs],
            environment: Object.entries(request.env).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
      tags: this.buildTags(request),
    };
  }

  private buildTags(request: ExternalTaskLaunchRequest): readonly EcsFargateTag[] {
    const requestTags = Object.entries(request.labels).map(([key, value]) => ({
      key,
      value,
    }));
    return [...this.options.tags, ...requestTags];
  }
}
