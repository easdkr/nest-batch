import { describe, expect, test } from 'vitest';
import type { BatchScheduleEntry, BatchScheduleRegistry } from '@nest-batch/core';

import {
  EventBridgeSchedulerService,
  toEventBridgeCron,
} from '../src/eventbridge-scheduler.service';

const entry: BatchScheduleEntry = {
  jobId: 'import-products',
  methodName: 'run',
  cron: '*/5 * * * *',
  timezone: 'Asia/Seoul',
  inert: false,
};

describe('EventBridgeSchedulerService', () => {
  test('converts a 5-field cron expression to EventBridge Scheduler cron', () => {
    expect(toEventBridgeCron('*/5 * * * *')).toBe('cron(*/5 * * * * *)');
  });

  test('builds CreateSchedule input from registry entry', () => {
    const registry = {
      getAll() {
        return [entry];
      },
    } as unknown as BatchScheduleRegistry;
    const service = new EventBridgeSchedulerService(registry, {
      client: {
        async createSchedule() {
          return {};
        },
      },
      scheduleNamePrefix: 'batch',
      state: 'ENABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        Arn: 'arn:aws:sqs:ap-northeast-2:123:batch',
        RoleArn: 'arn:aws:iam::123:role/scheduler',
      },
      deleteOnShutdown: false,
    });

    const input = service.buildCreateScheduleInput(entry);
    expect(input.Name).toBe('batch-import-products-run');
    expect(input.ScheduleExpression).toBe('cron(*/5 * * * * *)');
    expect(input.ScheduleExpressionTimezone).toBe('Asia/Seoul');
    expect(input.Target.Arn).toBe('arn:aws:sqs:ap-northeast-2:123:batch');
    expect(JSON.parse(input.Target.Input ?? '{}')).toMatchObject({
      jobId: 'import-products',
      methodName: 'run',
    });
  });
});
