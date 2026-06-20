import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  ExternalTaskExecutionStrategy,
  type BatchAdapter,
} from '@nest-batch/core';

import { EcsFargateTaskLauncher } from './ecs-fargate-task-launcher';
import {
  ECS_FARGATE_MODULE_OPTIONS,
  type EcsFargateModuleOptions,
  type ResolvedEcsFargateModuleOptions,
  resolveEcsFargateOptions,
} from './module-options';

@Module({})
export class EcsFargateModule {}

const ADAPTER_EXPORTS: ReadonlyArray<
  symbol | typeof ExternalTaskExecutionStrategy | typeof EcsFargateTaskLauncher
> = [
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  ECS_FARGATE_MODULE_OPTIONS,
  ExternalTaskExecutionStrategy,
  EcsFargateTaskLauncher,
];

export class EcsFargateAdapter {
  static forRoot(options: EcsFargateModuleOptions): BatchAdapter {
    const resolved = resolveEcsFargateOptions(options);
    return {
      name: 'aws-ecs-fargate',
      module: buildEcsFargateDynamicModule({
        providers: buildStaticProviders(resolved),
      }),
    };
  }
}

function buildStaticProviders(resolved: ResolvedEcsFargateModuleOptions): Provider[] {
  return [
    EcsFargateTaskLauncher,
    ExternalTaskExecutionStrategy,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: ExternalTaskExecutionStrategy,
    },
    {
      provide: EXTERNAL_TASK_LAUNCHER,
      useExisting: EcsFargateTaskLauncher,
    },
    {
      provide: EXTERNAL_TASK_STRATEGY_OPTIONS,
      useValue: {
        workerCommand: resolved.workerCommand,
        env: resolved.env,
        labels: resolved.labels,
      },
    },
    {
      provide: ECS_FARGATE_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

function buildEcsFargateDynamicModule(args: { providers: Provider[] }): DynamicModule {
  return {
    module: EcsFargateModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
}
