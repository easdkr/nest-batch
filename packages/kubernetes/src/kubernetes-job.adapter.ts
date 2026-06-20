import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  ExternalTaskExecutionStrategy,
  type BatchAdapter,
} from '@nest-batch/core';

import { KubernetesJobLauncher } from './kubernetes-job-launcher';
import {
  KUBERNETES_JOB_MODULE_OPTIONS,
  type KubernetesJobModuleOptions,
  type ResolvedKubernetesJobModuleOptions,
  resolveKubernetesJobOptions,
} from './module-options';

@Module({})
export class KubernetesJobModule {}

const ADAPTER_EXPORTS: ReadonlyArray<
  symbol | typeof ExternalTaskExecutionStrategy | typeof KubernetesJobLauncher
> = [
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
  KUBERNETES_JOB_MODULE_OPTIONS,
  ExternalTaskExecutionStrategy,
  KubernetesJobLauncher,
];

export class KubernetesJobAdapter {
  static forRoot(options: KubernetesJobModuleOptions): BatchAdapter {
    const resolved = resolveKubernetesJobOptions(options);
    return {
      name: 'kubernetes-job',
      module: buildKubernetesJobDynamicModule({
        providers: buildStaticProviders(resolved),
      }),
    };
  }
}

function buildStaticProviders(resolved: ResolvedKubernetesJobModuleOptions): Provider[] {
  return [
    KubernetesJobLauncher,
    ExternalTaskExecutionStrategy,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: ExternalTaskExecutionStrategy,
    },
    {
      provide: EXTERNAL_TASK_LAUNCHER,
      useExisting: KubernetesJobLauncher,
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
      provide: KUBERNETES_JOB_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

function buildKubernetesJobDynamicModule(args: { providers: Provider[] }): DynamicModule {
  return {
    module: KubernetesJobModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
}
