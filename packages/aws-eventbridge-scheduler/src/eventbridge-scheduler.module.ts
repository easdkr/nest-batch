import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { EventBridgeSchedulerService } from './eventbridge-scheduler.service';
import {
  EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS,
  type EventBridgeSchedulerModuleOptions,
  resolveEventBridgeSchedulerOptions,
} from './module-options';

@Module({})
export class EventBridgeSchedulerModule {
  static forRoot(options: EventBridgeSchedulerModuleOptions): DynamicModule {
    const providers: Provider[] = [
      EventBridgeSchedulerService,
      {
        provide: EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS,
        useValue: resolveEventBridgeSchedulerOptions(options),
      },
    ];
    return {
      module: EventBridgeSchedulerModule,
      global: true,
      providers,
      exports: [EventBridgeSchedulerService, EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS],
    };
  }
}
