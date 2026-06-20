import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { EXECUTION_STRATEGY, type BatchAdapter } from '@nest-batch/core';

import { SqsExecutionStrategy } from './sqs-execution-strategy';
import {
  AWS_SQS_MODULE_OPTIONS,
  type ResolvedSqsModuleOptions,
  type SqsModuleOptions,
  resolveSqsOptions,
} from './module-options';

@Module({})
export class SqsModule {}

const ADAPTER_EXPORTS: ReadonlyArray<symbol | typeof SqsExecutionStrategy> = [
  EXECUTION_STRATEGY,
  AWS_SQS_MODULE_OPTIONS,
  SqsExecutionStrategy,
];

export class SqsAdapter {
  static forRoot(options: SqsModuleOptions): BatchAdapter {
    const resolved = resolveSqsOptions(options);
    return {
      name: 'aws-sqs',
      module: buildSqsDynamicModule({
        providers: buildStaticProviders(resolved),
      }),
    };
  }
}

function buildStaticProviders(resolved: ResolvedSqsModuleOptions): Provider[] {
  return [
    SqsExecutionStrategy,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: SqsExecutionStrategy,
    },
    {
      provide: AWS_SQS_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

function buildSqsDynamicModule(args: { providers: Provider[] }): DynamicModule {
  return {
    module: SqsModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
}
