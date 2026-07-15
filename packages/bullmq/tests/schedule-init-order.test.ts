import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  Batch,
  BatchScheduled,
  InMemoryJobRepository,
  InMemoryTransactionManager,
  JOB_REPOSITORY_TOKEN,
  JobRepository,
  NestBatchModule,
  TRANSACTION_MANAGER_TOKEN,
  TransactionManager,
  type BatchAdapter,
} from '@nest-batch/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BullmqAdapter } from '../src/adapters/bullmq.adapter';
import { BullmqSchedule } from '../src/bullmq-schedule';

const bullmqMock = vi.hoisted(() => {
  const upsertJobScheduler = vi.fn(async () => undefined);
  const queueClose = vi.fn(async () => undefined);
  const Queue = vi.fn().mockImplementation(() => ({
    add: vi.fn(async () => ({ id: 'mock-job-id' })),
    close: queueClose,
    upsertJobScheduler,
    waitUntilReady: vi.fn(async () => undefined),
  }));

  const queueEventsClose = vi.fn(async () => undefined);
  const QueueEvents = vi.fn().mockImplementation(() => ({
    close: queueEventsClose,
    on: vi.fn(),
  }));

  const workerClose = vi.fn(async () => undefined);
  const Worker = vi.fn().mockImplementation(() => ({ close: workerClose }));

  return {
    Queue,
    QueueEvents,
    Worker,
    queueClose,
    queueEventsClose,
    upsertJobScheduler,
    workerClose,
  };
});

vi.mock('bullmq', () => ({
  Queue: bullmqMock.Queue,
  QueueEvents: bullmqMock.QueueEvents,
  Worker: bullmqMock.Worker,
}));

@Batch.Jobable({ id: 'scheduled-job' })
class ScheduledJob {
  @BatchScheduled('*/5 * * * *', { name: 'every-five-minutes', timezone: 'UTC' })
  scheduled(): void {}

  @Batch.Stepable({ id: 'run' })
  @Batch.Tasklet()
  async run(): Promise<void> {}
}

const inMemoryPersistence: BatchAdapter = {
  name: 'in-memory',
  module: {
    module: class InMemoryPersistenceModule {},
    global: true,
    providers: [
      {
        provide: InMemoryJobRepository,
        useFactory: () => new InMemoryJobRepository(),
      },
      {
        provide: InMemoryTransactionManager,
        useFactory: () => new InMemoryTransactionManager(),
      },
      { provide: JobRepository, useExisting: InMemoryJobRepository },
      { provide: TransactionManager, useExisting: InMemoryTransactionManager },
    ],
    exports: [InMemoryJobRepository, InMemoryTransactionManager, JobRepository, TransactionManager],
  },
  globalProviders: [
    { provide: JOB_REPOSITORY_TOKEN, useExisting: InMemoryJobRepository },
    { provide: TRANSACTION_MANAGER_TOKEN, useExisting: InMemoryTransactionManager },
    { provide: JobRepository, useExisting: InMemoryJobRepository },
    { provide: TransactionManager, useExisting: InMemoryTransactionManager },
  ],
};

const bullmqTransport = BullmqAdapter.forRoot({ autoStartWorker: false });

describe('BullmqSchedule Nest lifecycle ordering', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('installs schedules discovered by the host module during application bootstrap', async () => {
    const app = await NestFactory.createApplicationContext(
      {
        module: class TestRootModule {},
        imports: [
          // Reproduce a host that imports the transport runtime directly
          // before composing the core module. Nest then bootstraps the
          // BullMQ provider before BatchBootstrapper.
          bullmqTransport.module,
          NestBatchModule.forRoot({
            adapters: {
              persistence: inMemoryPersistence,
              transport: bullmqTransport,
            },
          }),
        ],
        providers: [ScheduledJob],
      },
      { logger: false },
    );

    try {
      expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
      expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledWith(
        'scheduled-job::every-five-minutes',
        { pattern: '*/5 * * * *', tz: 'UTC' },
        expect.objectContaining({
          name: 'every-five-minutes',
          data: {
            jobId: 'scheduled-job',
            methodName: 'scheduled',
            scheduleName: 'every-five-minutes',
          },
        }),
      );
      expect(app.get(BullmqSchedule).installedSchedulerKeys()).toEqual([
        'scheduled-job::every-five-minutes',
      ]);
    } finally {
      await app.close();
    }
  });
});
