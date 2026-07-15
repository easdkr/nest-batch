import { BatchScheduleRegistry, type JobLauncher } from '@nest-batch/core';
import { Queue } from 'bullmq';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BULLMQ_SCHEDULE_QUEUE_NAME, BullmqSchedule } from '../src/bullmq-schedule';

import type { ResolvedBullMqModuleOptions } from '../src/module-options';

const describeE2E = process.env.RUN_BULLMQ_E2E === '1' ? describe : describe.skip;

function fakeLauncher(): JobLauncher {
  return {
    launch: async () => ({ id: 'execution-1', status: 'STARTING' }),
  } as unknown as JobLauncher;
}

describeE2E('BullmqSchedule Redis readiness', () => {
  let redis: StartedTestContainer;

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withCommand(['redis-server', '--appendonly', 'no', '--maxmemory-policy', 'noeviction'])
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('waits for the Redis connection before installing every registered scheduler', async () => {
    const registry = new BatchScheduleRegistry();
    registry.register({
      jobId: 'job-a',
      methodName: 'firstSchedule',
      scheduleName: 'first',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      inert: false,
    });
    registry.register({
      jobId: 'job-b',
      methodName: 'secondSchedule',
      scheduleName: 'second',
      cron: '*/10 * * * *',
      timezone: 'Asia/Seoul',
      inert: false,
    });

    const prefix = `e2e:schedule-readiness:${process.pid}:${Date.now()}:`;
    const connection = {
      host: redis.getHost(),
      port: redis.getMappedPort(6379),
    };
    const options: ResolvedBullMqModuleOptions = {
      connection: {
        ...connection,
        password: undefined,
        username: undefined,
        db: 0,
        keyPrefix: prefix,
        tls: false,
      },
      autoStartWorker: false,
    };
    const schedule = new BullmqSchedule(registry, options, fakeLauncher());
    const inspectionQueue = new Queue(BULLMQ_SCHEDULE_QUEUE_NAME, {
      connection,
      prefix,
    });

    try {
      await schedule.onApplicationBootstrap();

      expect(schedule.installedSchedulerKeys()).toEqual(['job-a::first', 'job-b::second']);

      await inspectionQueue.waitUntilReady();
      const installed = await inspectionQueue.getJobSchedulers(0, -1, true);
      expect(installed.map(({ key }) => key)).toEqual(['job-a::first', 'job-b::second']);
    } finally {
      await Promise.all([schedule.onApplicationShutdown(), inspectionQueue.close()]);
    }
  });
});
