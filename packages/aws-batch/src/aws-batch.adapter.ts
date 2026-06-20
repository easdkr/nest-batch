import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  ExternalTaskExecutionStrategy,
  type BatchAdapter,
} from '@nest-batch/core';

import { AwsBatchJobLauncher } from './aws-batch-job-launcher';
import {
  AWS_BATCH_MODULE_OPTIONS,
  type AwsBatchModuleOptions,
  type ResolvedAwsBatchModuleOptions,
  resolveAwsBatchOptions,
} from './module-options';

@Module({})
export class AwsBatchModule {}

const ADAPTER_EXPORTS: ReadonlyArray<
  symbol | typeof ExternalTaskExecutionStrategy | typeof AwsBatchJobLauncher
> = [
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  AWS_BATCH_MODULE_OPTIONS,
  ExternalTaskExecutionStrategy,
  AwsBatchJobLauncher,
];

export class AwsBatchAdapter {
  static forRoot(options: AwsBatchModuleOptions): BatchAdapter {
    const resolved = resolveAwsBatchOptions(options);
    return {
      name: 'aws-batch',
      module: buildAwsBatchDynamicModule({
        providers: buildStaticProviders(resolved),
      }),
    };
  }
}

function buildStaticProviders(resolved: ResolvedAwsBatchModuleOptions): Provider[] {
  return [
    AwsBatchJobLauncher,
    ExternalTaskExecutionStrategy,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: ExternalTaskExecutionStrategy,
    },
    {
      provide: EXTERNAL_TASK_LAUNCHER,
      useExisting: AwsBatchJobLauncher,
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
      provide: AWS_BATCH_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

function buildAwsBatchDynamicModule(args: { providers: Provider[] }): DynamicModule {
  return {
    module: AwsBatchModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
}
