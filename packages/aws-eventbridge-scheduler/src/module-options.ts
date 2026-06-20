import type { BatchScheduleEntry } from '@nest-batch/core';

export const EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/aws-eventbridge-scheduler/EVENTBRIDGE_SCHEDULER_MODULE_OPTIONS',
);

export interface EventBridgeSchedulerTarget {
  readonly Arn: string;
  readonly RoleArn: string;
  readonly Input?: string;
  readonly DeadLetterConfig?: { readonly Arn: string };
  readonly RetryPolicy?: {
    readonly MaximumEventAgeInSeconds?: number;
    readonly MaximumRetryAttempts?: number;
  };
}

export interface EventBridgeCreateScheduleInput {
  readonly Name: string;
  readonly GroupName?: string;
  readonly ScheduleExpression: string;
  readonly ScheduleExpressionTimezone?: string;
  readonly FlexibleTimeWindow: {
    readonly Mode: 'OFF' | 'FLEXIBLE';
    readonly MaximumWindowInMinutes?: number;
  };
  readonly State?: 'ENABLED' | 'DISABLED';
  readonly StartDate?: Date;
  readonly EndDate?: Date;
  readonly Target: EventBridgeSchedulerTarget;
}

export interface EventBridgeDeleteScheduleInput {
  readonly Name: string;
  readonly GroupName?: string;
}

export interface EventBridgeSchedulerClient {
  createSchedule(input: EventBridgeCreateScheduleInput): Promise<{ readonly ScheduleArn?: string }>;
  deleteSchedule?(input: EventBridgeDeleteScheduleInput): Promise<void>;
}

export interface EventBridgeSchedulerModuleOptions {
  readonly client: EventBridgeSchedulerClient;
  readonly groupName?: string;
  readonly scheduleNamePrefix?: string;
  readonly state?: 'ENABLED' | 'DISABLED';
  readonly flexibleTimeWindow?: {
    readonly mode: 'OFF' | 'FLEXIBLE';
    readonly maximumWindowInMinutes?: number;
  };
  readonly target: Omit<EventBridgeSchedulerTarget, 'Input'> & {
    readonly input?: (entry: BatchScheduleEntry) => string;
  };
  readonly deleteOnShutdown?: boolean;
}

export interface ResolvedEventBridgeSchedulerModuleOptions {
  readonly client: EventBridgeSchedulerClient;
  readonly groupName?: string;
  readonly scheduleNamePrefix: string;
  readonly state: 'ENABLED' | 'DISABLED';
  readonly flexibleTimeWindow: {
    readonly mode: 'OFF' | 'FLEXIBLE';
    readonly maximumWindowInMinutes?: number;
  };
  readonly target: EventBridgeSchedulerModuleOptions['target'];
  readonly deleteOnShutdown: boolean;
}

export function resolveEventBridgeSchedulerOptions(
  options: EventBridgeSchedulerModuleOptions,
): ResolvedEventBridgeSchedulerModuleOptions {
  return Object.freeze({
    client: options.client,
    ...(options.groupName !== undefined ? { groupName: options.groupName } : {}),
    scheduleNamePrefix: options.scheduleNamePrefix ?? 'nest-batch',
    state: options.state ?? 'ENABLED',
    flexibleTimeWindow: Object.freeze({
      mode: options.flexibleTimeWindow?.mode ?? 'OFF',
      ...(options.flexibleTimeWindow?.maximumWindowInMinutes !== undefined
        ? { maximumWindowInMinutes: options.flexibleTimeWindow.maximumWindowInMinutes }
        : {}),
    }),
    target: options.target,
    deleteOnShutdown: options.deleteOnShutdown ?? false,
  });
}
