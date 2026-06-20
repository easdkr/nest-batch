import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  BATCH_SCHEDULE_REGISTRY,
  type BatchScheduleEntry,
  type BatchScheduleRegistry,
} from '@nest-batch/core';

import {
  EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS,
  type EventBridgeCreateScheduleInput,
  type ResolvedEventBridgeSchedulerModuleOptions,
} from './module-options';

@Injectable()
export class EventBridgeSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EventBridgeSchedulerService.name);
  private readonly installedNames = new Set<string>();

  constructor(
    @Inject(BATCH_SCHEDULE_REGISTRY)
    private readonly scheduleRegistry: BatchScheduleRegistry,
    @Inject(EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS)
    private readonly options: ResolvedEventBridgeSchedulerModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const entries = this.scheduleRegistry.getAll();
    for (const entry of entries) {
      if (entry.inert) {
        this.logger.log(`Skipping inert schedule: ${entry.jobId}::${entry.methodName}`);
        continue;
      }
      const input = this.buildCreateScheduleInput(entry);
      await this.options.client.createSchedule(input);
      this.installedNames.add(input.Name);
      this.logger.log(`Installed EventBridge schedule: ${input.Name}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.options.deleteOnShutdown || this.options.client.deleteSchedule === undefined) {
      return;
    }
    for (const name of this.installedNames) {
      await this.options.client.deleteSchedule({
        Name: name,
        ...(this.options.groupName !== undefined ? { GroupName: this.options.groupName } : {}),
      });
    }
    this.installedNames.clear();
  }

  installedSchedulerKeys(): readonly string[] {
    return Array.from(this.installedNames);
  }

  buildCreateScheduleInput(entry: BatchScheduleEntry): EventBridgeCreateScheduleInput {
    const scheduleExpression = toEventBridgeCron(entry.cron);
    const input = this.options.target.input?.(entry) ?? JSON.stringify({
      jobId: entry.jobId,
      methodName: entry.methodName,
      scheduleName: `${entry.jobId}::${entry.methodName}`,
    });

    return {
      Name: this.buildScheduleName(entry),
      ...(this.options.groupName !== undefined ? { GroupName: this.options.groupName } : {}),
      ScheduleExpression: scheduleExpression,
      ScheduleExpressionTimezone: entry.timezone,
      FlexibleTimeWindow: {
        Mode: this.options.flexibleTimeWindow.mode,
        ...(this.options.flexibleTimeWindow.maximumWindowInMinutes !== undefined
          ? {
              MaximumWindowInMinutes:
                this.options.flexibleTimeWindow.maximumWindowInMinutes,
            }
          : {}),
      },
      State: this.options.state,
      ...(entry.startAt !== undefined ? { StartDate: entry.startAt } : {}),
      ...(entry.endAt !== undefined ? { EndDate: entry.endAt } : {}),
      Target: {
        Arn: this.options.target.Arn,
        RoleArn: this.options.target.RoleArn,
        Input: input,
        ...(this.options.target.DeadLetterConfig !== undefined
          ? { DeadLetterConfig: this.options.target.DeadLetterConfig }
          : {}),
        ...(this.options.target.RetryPolicy !== undefined
          ? { RetryPolicy: this.options.target.RetryPolicy }
          : {}),
      },
    };
  }

  private buildScheduleName(entry: BatchScheduleEntry): string {
    const raw = `${this.options.scheduleNamePrefix}-${entry.jobId}-${entry.methodName}`;
    return raw.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
  }
}

export function toEventBridgeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`EventBridge Scheduler supports 5-field cron expressions, got ${parts.length}`);
  }
  return `cron(${parts.join(' ')} *)`;
}
