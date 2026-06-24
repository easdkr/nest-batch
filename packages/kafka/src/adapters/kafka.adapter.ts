import { EXECUTION_STRATEGY, type BatchAdapter } from '@nest-batch/core';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { resolveKafkaConnection } from '../connection';
import { KafkaExecutionStrategy } from '../kafka-execution-strategy';
import { KafkaRuntime } from '../kafka-runtime';
import { KafkaSchedule } from '../kafka-schedule';
import {
  KAFKA_MODULE_OPTIONS,
  type KafkaModuleOptions,
  type ResolvedKafkaModuleOptions,
} from '../module-options';

/**
 * Empty Nest module class that owns the Kafka transport's
 * provider graph.
 *
 * Mirrors `BullmqModule` in `@nest-batch/bullmq/src/adapters/
 * bullmq.adapter.ts`: the class has no body on purpose. It is
 * purely a `DynamicModule` carrier — Nest's module system requires
 * *some* class to identify the module, and the empty class is the
 * minimum possible surface (no decorators, no lifecycle hooks, no
 * metadata). All real behaviour lives on the providers.
 */
@Module({})
export class KafkaModule {}

/**
 * Sentinel token for the async-options factory chain.
 */
const OPTIONS_FACTORY: symbol = Symbol.for('@nest-batch/kafka/OPTIONS_FACTORY');

/**
 * The list of exports the Kafka adapter's `DynamicModule` exposes
 * to the host application.
 */
const ADAPTER_EXPORTS: ReadonlyArray<
  symbol | typeof KafkaExecutionStrategy | typeof KafkaRuntime | typeof KafkaSchedule
> = [EXECUTION_STRATEGY, KAFKA_MODULE_OPTIONS, KafkaExecutionStrategy, KafkaRuntime, KafkaSchedule];

/**
 * `KafkaAdapter` — the transport adapter for `@nest-batch/kafka`
 * used by the new factory-pattern
 * `NestBatchModule.forRoot({ adapters: { transport, ... } })` API.
 *
 * Overrides the default `EXECUTION_STRATEGY` token with a Kafka-
 * backed `IExecutionStrategy` (`KafkaExecutionStrategy`) and wires
 * the runtime services that own the Kafka client lifecycle
 * (`KafkaRuntime` for step produce + consume, plus
 * `KafkaSchedule` for `@BatchScheduled` cron entries).
 *
 * Two static methods:
 *
 *   - `forRoot(options)` — synchronous configuration.
 *
 *   - `forRootAsync({ imports, inject, useFactory })` — async
 *     configuration.
 *
 * @example
 * ```ts
 * // Synchronous wiring (connection known at module-build time)
 * import { Module } from '@nestjs/common';
 * import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
 * import { MikroOrmAdapter } from '@nest-batch/mikro-orm';
 * import { KafkaAdapter } from '@nest-batch/kafka';
 *
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({
 *       adapters: {
 *         persistence: MikroOrmAdapter,
 *         transport: KafkaAdapter.forRoot({
 *           connection: {
 *             brokers: ['localhost:9092'],
 *             clientId: 'my-app',
 *           },
 *           autoStartConsumer: true,
 *         }),
 *       },
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export class KafkaAdapter {
  /**
   * Synchronous configuration.
   *
   * No options object is required: the module accepts an empty
   * `{}` and applies all defaults (broker `127.0.0.1:9092`,
   * clientId `nest-batch`, `autoStartConsumer: false`).
   */
  static forRoot(options: KafkaModuleOptions = {}): BatchAdapter {
    const resolved: ResolvedKafkaModuleOptions = Object.freeze({
      connection: resolveKafkaConnection(options.connection),
      autoStartConsumer: options.autoStartConsumer ?? false,
      consumerGroupId: options.consumerGroupId ?? 'nest-batch-consumer',
      topic: options.topic ?? 'nest-batch-work',
    });
    const providers = buildStaticProviders(resolved);
    return {
      name: 'kafka',
      module: buildKafkaDynamicModule({
        providers,
      }),
    };
  }

  /**
   * Async configuration — useful when the Kafka connection comes
   * from a config service or another async provider.
   */
  static forRootAsync(asyncOptions: {
    imports?: DynamicModule['imports'];
    inject?: readonly unknown[];
    useFactory: (...args: unknown[]) => Promise<KafkaModuleOptions> | KafkaModuleOptions;
  }): BatchAdapter {
    const factoryProvider: Provider = {
      provide: OPTIONS_FACTORY,
      useFactory: asyncOptions.useFactory as (...args: unknown[]) => unknown,
      inject: [...(asyncOptions.inject ?? [])] as Array<string | symbol | (() => unknown)>,
    };

    const mergedOptionsProvider: Provider = {
      provide: KAFKA_MODULE_OPTIONS,
      useFactory: (fromFactory: KafkaModuleOptions | undefined): ResolvedKafkaModuleOptions => {
        return Object.freeze({
          connection: resolveKafkaConnection(fromFactory?.connection),
          autoStartConsumer: fromFactory?.autoStartConsumer ?? false,
          consumerGroupId: fromFactory?.consumerGroupId ?? 'nest-batch-consumer',
          topic: fromFactory?.topic ?? 'nest-batch-work',
        });
      },
      inject: [OPTIONS_FACTORY],
    };

    const baseProviders = buildStaticProviders(
      Object.freeze({
        connection: resolveKafkaConnection(undefined),
        autoStartConsumer: false,
        consumerGroupId: 'nest-batch-consumer',
        topic: 'nest-batch-work',
      }),
    );
    const filtered = baseProviders.filter(
      (p) =>
        !(
          typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          (p as { provide: unknown }).provide === KAFKA_MODULE_OPTIONS
        ),
    );

    const providers = [factoryProvider, mergedOptionsProvider, ...filtered];
    return {
      name: 'kafka',
      module: buildKafkaDynamicModule({
        providers,
        imports: asyncOptions.imports,
      }),
    };
  }
}

/**
 * Build the static provider list shared by `forRoot()` and
 * `forRootAsync()`.
 */
function buildStaticProviders(resolved: ResolvedKafkaModuleOptions): Provider[] {
  return [
    KafkaExecutionStrategy,
    KafkaRuntime,
    KafkaSchedule,
    {
      provide: EXECUTION_STRATEGY,
      useExisting: KafkaExecutionStrategy,
    },
    {
      provide: KAFKA_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

/**
 * Build the `DynamicModule` payload for the Kafka adapter.
 */
function buildKafkaDynamicModule(args: {
  providers: Provider[];
  imports?: DynamicModule['imports'];
}): DynamicModule {
  const module: DynamicModule = {
    module: KafkaModule,
    global: true,
    providers: args.providers,
    exports: [...ADAPTER_EXPORTS],
  };
  if (args.imports !== undefined) {
    return { ...module, imports: [...args.imports] };
  }
  return module;
}
