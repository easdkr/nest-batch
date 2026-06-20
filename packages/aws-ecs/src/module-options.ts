import type { ExternalTaskStrategyOptions } from '@nest-batch/core';

export const ECS_FARGATE_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/aws-ecs/ECS_FARGATE_MODULE_OPTIONS',
);

export interface EcsFargateTag {
  readonly key: string;
  readonly value: string;
}

export interface EcsFargateNetworkConfiguration {
  readonly subnets: readonly string[];
  readonly securityGroups?: readonly string[];
  readonly assignPublicIp?: 'ENABLED' | 'DISABLED';
}

export interface EcsFargateRunTaskInput {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly launchType: 'FARGATE';
  readonly platformVersion?: string;
  readonly startedBy?: string;
  readonly enableExecuteCommand?: boolean;
  readonly networkConfiguration: {
    readonly awsvpcConfiguration: EcsFargateNetworkConfiguration;
  };
  readonly overrides: {
    readonly containerOverrides: readonly [
      {
        readonly name: string;
        readonly command: readonly string[];
        readonly environment: readonly { readonly name: string; readonly value: string }[];
      },
    ];
  };
  readonly tags?: readonly EcsFargateTag[];
}

export interface EcsFargateRunTaskOutput {
  readonly tasks?: readonly { readonly taskArn?: string }[];
  readonly failures?: readonly {
    readonly arn?: string;
    readonly reason?: string;
    readonly detail?: string;
  }[];
}

export interface EcsFargateRunTaskClient {
  runTask(input: EcsFargateRunTaskInput): Promise<EcsFargateRunTaskOutput>;
}

export interface EcsFargateModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: EcsFargateRunTaskClient;
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly containerName: string;
  readonly networkConfiguration: EcsFargateNetworkConfiguration;
  readonly platformVersion?: string;
  readonly startedBy?: string;
  readonly enableExecuteCommand?: boolean;
  readonly tags?: readonly EcsFargateTag[];
}

export interface ResolvedEcsFargateModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: EcsFargateRunTaskClient;
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly containerName: string;
  readonly networkConfiguration: EcsFargateNetworkConfiguration;
  readonly platformVersion?: string;
  readonly startedBy?: string;
  readonly enableExecuteCommand: boolean;
  readonly tags: readonly EcsFargateTag[];
}

export function resolveEcsFargateOptions(
  options: EcsFargateModuleOptions,
): ResolvedEcsFargateModuleOptions {
  return Object.freeze({
    client: options.client,
    cluster: options.cluster,
    taskDefinition: options.taskDefinition,
    containerName: options.containerName,
    networkConfiguration: Object.freeze({
      subnets: Object.freeze([...options.networkConfiguration.subnets]),
      ...(options.networkConfiguration.securityGroups !== undefined
        ? { securityGroups: Object.freeze([...options.networkConfiguration.securityGroups]) }
        : {}),
      assignPublicIp: options.networkConfiguration.assignPublicIp ?? 'DISABLED',
    }),
    ...(options.platformVersion !== undefined ? { platformVersion: options.platformVersion } : {}),
    ...(options.startedBy !== undefined ? { startedBy: options.startedBy } : {}),
    enableExecuteCommand: options.enableExecuteCommand ?? false,
    tags: Object.freeze([...(options.tags ?? [])]),
    ...(options.workerCommand !== undefined
      ? { workerCommand: Object.freeze([...options.workerCommand]) }
      : {}),
    ...(options.env !== undefined ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.labels !== undefined ? { labels: Object.freeze({ ...options.labels }) } : {}),
  });
}
