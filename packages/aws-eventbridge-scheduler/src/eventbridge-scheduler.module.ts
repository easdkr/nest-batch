import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { EventBridgeScheduler } from './eventbridge-scheduler';
import {
  EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS,
  type EventBridgeSchedulerModuleOptions,
  resolveEventBridgeSchedulerOptions,
} from './module-options';

@Module({})
export class EventBridgeSchedulerModule {
  static forRoot(options: EventBridgeSchedulerModuleOptions): DynamicModule {
    const providers: Provider[] = [
      EventBridgeScheduler,
      {
        provide: EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS,
        useValue: resolveEventBridgeSchedulerOptions(options),
      },
    ];
    return {
      module: EventBridgeSchedulerModule,
      global: true,
      providers,
      exports: [EventBridgeScheduler, EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS],
    };
  }
}
