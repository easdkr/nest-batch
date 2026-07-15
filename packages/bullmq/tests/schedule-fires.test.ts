/**
 * T-AC-4 acceptance test: BullmqSchedule must call
 * Queue.upsertJobScheduler with the pattern and tz carried on the
 * BatchScheduleEntry it reads from BatchScheduleRegistry.
 *
 * What this test pins (RED-first, then asserts the implementation
 * already does the right thing on the feature branch):
 *
 *   1. Cron fires: register a single non-inert entry, then call
 *      onApplicationBootstrap. Assert the Queue constructor was
 *      called with the schedule queue name and a connection record,
 *      and that upsertJobScheduler was called exactly once with the
 *      composite key (jobId::scheduleName) and the entry cron/tz.
 *
 *   2. Inert mode: with BATCH_SCHEDULED_DISABLE=1 and an entry
 *      stamped inert=true (matching what @BatchScheduled captures
 *      at decoration time), assert the queue is built but
 *      upsertJobScheduler is NOT called and the installed scheduler
 *      set is empty.
 *
 * The test does NOT require Redis. The bullmq module is replaced
 * with a fake Queue whose upsertJobScheduler is a vi.fn() spied
 * stub. Vitest fake timers are enabled so the test is deterministic
 * and well under the 5s wall-clock budget.
 *
 * Pinned source:
 *   packages/bullmq/src/bullmq-schedule.ts lines 184-188
 *     the upsertJobScheduler call
 *   packages/core/src/module/batch-schedule-registry.ts
 *     BatchScheduleRegistry and BatchScheduleEntry
 *   packages/core/src/scheduling/batch-scheduled.ts lines 241-258
 *     @BatchScheduled stamps inert from BATCH_SCHEDULED_DISABLE
 */

import { BatchScheduleRegistry, type JobLauncher } from '@nest-batch/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BULLMQ_SCHEDULE_QUEUE_NAME, BullmqSchedule } from '../src/bullmq-schedule';

import type { ResolvedBullMqModuleOptions } from '../src/module-options';

// ---------------------------------------------------------------------------
// `bullmq` mock
// ---------------------------------------------------------------------------
//
// `vi.mock` factory bodies run at hoist time, so we use `vi.hoisted` to
// share the spied `upsertJobScheduler` across the mock factory and the
// test body. The fake `Queue` exposes the same surface `BullmqSchedule`
// touches: a constructor (spied for name + connection assertion),
// `upsertJobScheduler` (the call under test), `removeJobScheduler`
// (used to model the destructive legacy shutdown), and `close`.

const bullmqMock = vi.hoisted(() => {
  const sharedSchedulers = new Set<string>();
  const waitUntilReady = vi.fn(async () => undefined);
  const upsertJobScheduler = vi.fn(async (key: string) => {
    sharedSchedulers.add(key);
  });
  const removeJobScheduler = vi.fn(async (key: string) => {
    sharedSchedulers.delete(key);
  });
  const queueClose = vi.fn(async () => undefined);
  const workerClose = vi.fn(async () => undefined);
  let workerProcessor: ((job: unknown) => Promise<unknown>) | null = null;
  const Queue = vi.fn().mockImplementation(() => ({
    waitUntilReady,
    upsertJobScheduler,
    removeJobScheduler,
    close: queueClose,
  }));
  const Worker = vi.fn().mockImplementation((_name, processor) => {
    workerProcessor = processor as (job: unknown) => Promise<unknown>;
    return { close: workerClose };
  });
  return {
    sharedSchedulers,
    waitUntilReady,
    upsertJobScheduler,
    removeJobScheduler,
    queueClose,
    workerClose,
    Queue,
    Worker,
    getWorkerProcessor: () => workerProcessor,
  };
});

vi.mock('bullmq', () => ({
  Queue: bullmqMock.Queue,
  Worker: bullmqMock.Worker,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseOptions: ResolvedBullMqModuleOptions = {
  connection: {
    host: '127.0.0.1',
    port: 6379,
    password: undefined,
    username: undefined,
    db: 0,
    keyPrefix: 'nest-batch-test:',
    tls: false,
  },
  autoStartWorker: false,
};

function buildRegistry(cron: string, timezone: string, inert: boolean): BatchScheduleRegistry {
  const registry = new BatchScheduleRegistry();
  registry.register({
    jobId: 'jobA',
    methodName: 'method',
    scheduleName: 'hourly',
    cron,
    timezone,
    inert,
  });
  return registry;
}

function fakeLauncher(): JobLauncher {
  return {
    launch: vi.fn(async () => ({
      id: 'execution-1',
      status: 'STARTING',
    })),
  } as unknown as JobLauncher;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BullmqSchedule — T-AC-4 cron-firing acceptance', () => {
  beforeEach(() => {
    bullmqMock.sharedSchedulers.clear();
    bullmqMock.Queue.mockClear();
    bullmqMock.Worker.mockClear();
    bullmqMock.waitUntilReady.mockClear();
    bullmqMock.upsertJobScheduler.mockClear();
    bullmqMock.removeJobScheduler.mockClear();
    bullmqMock.queueClose.mockClear();
    bullmqMock.workerClose.mockClear();
    // Determinism: the impl does not actually wait on any timer, but
    // the spec calls for fake timers so any future drift that adds
    // a setTimeout keeps the test fast.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BATCH_SCHEDULED_DISABLE;
  });

  it('waits for the schedule queue to be ready before installing schedules', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    bullmqMock.waitUntilReady.mockImplementationOnce(() => ready);

    const registry = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const service = new BullmqSchedule(registry, baseOptions, fakeLauncher());

    const bootstrap = service.onApplicationBootstrap();
    await Promise.resolve();

    expect(bullmqMock.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(bullmqMock.upsertJobScheduler).not.toHaveBeenCalled();

    releaseReady();
    await bootstrap;

    expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the schedule queue when there are no schedules to install', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    bullmqMock.waitUntilReady.mockImplementationOnce(() => ready);

    const service = new BullmqSchedule(new BatchScheduleRegistry(), baseOptions, fakeLauncher());

    const bootstrap = service.onApplicationBootstrap();
    await Promise.resolve();
    const readinessCalls = bullmqMock.waitUntilReady.mock.calls.length;

    releaseReady();
    await bootstrap;

    expect(readinessCalls).toBe(0);
    expect(service.installedSchedulerKeys()).toEqual([]);
  });

  it('records a scheduler key only after upsertJobScheduler succeeds', async () => {
    bullmqMock.upsertJobScheduler.mockRejectedValueOnce(new Error('Redis connection is closed'));

    const registry = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const service = new BullmqSchedule(registry, baseOptions, fakeLauncher());

    await service.onApplicationBootstrap();

    expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(service.installedSchedulerKeys()).toEqual([]);
  });

  it("installs an upsertJobScheduler with the entry's pattern + tz when inert=false", async () => {
    // Sanity: make sure the env is in the "active" state for this test.
    process.env.BATCH_SCHEDULED_DISABLE = '0';

    const registry = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const service = new BullmqSchedule(registry, baseOptions, fakeLauncher());

    await service.onApplicationBootstrap();

    // 1. The schedule queue was constructed exactly once, with the
    //    documented queue name and a connection record derived from
    //    the resolved module options. The impl also forwards
    //    `connection.keyPrefix` as the BullMQ top-level `prefix`
    //    option (BullMQ keeps `prefix` separate from `connection`).
    expect(bullmqMock.Queue).toHaveBeenCalledTimes(1);
    expect(bullmqMock.Worker).not.toHaveBeenCalled();
    const [name, ctorOpts] = bullmqMock.Queue.mock.calls[0] ?? [];
    expect(name).toBe(BULLMQ_SCHEDULE_QUEUE_NAME);
    expect(ctorOpts).toBeDefined();
    const opts = ctorOpts as {
      connection?: { host?: string; port?: number };
      prefix?: string;
    };
    expect(opts.connection?.host).toBe(baseOptions.connection.host);
    expect(opts.connection?.port).toBe(baseOptions.connection.port);
    expect(opts.prefix).toBe(baseOptions.connection.keyPrefix);

    // 2. `upsertJobScheduler` was called exactly once.
    expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledTimes(1);

    // 3. The arguments pin the cron + tz + composite key. We assert
    //    the args positionally but use `objectContaining` on the
    //    template so a future change to its `opts` (retry policy,
    //    backoff) does not break this test — only the cron / tz
    //    contract is what T-AC-4 is pinning.
    const [key, patternArg, templateArg] = bullmqMock.upsertJobScheduler.mock.calls[0] ?? [];
    expect(key).toBe('jobA::hourly');
    expect(patternArg).toEqual({ pattern: '*/1 * * * * *', tz: 'UTC' });
    expect(templateArg).toEqual(
      expect.objectContaining({
        name: 'hourly',
        data: { jobId: 'jobA', scheduleName: 'hourly', methodName: 'method' },
        opts: expect.objectContaining({
          attempts: expect.any(Number),
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      }),
    );

    // 4. The installed-keys diagnostic reflects the installation.
    expect(service.installedSchedulerKeys()).toEqual(['jobA::hourly']);
  });

  it('skips upsertJobScheduler when the entry is inert (BATCH_SCHEDULED_DISABLE=1)', async () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';

    // Mirror what the decorator stamps: when the env is set, the
    // entry's `inert` flag is true. The runtime then logs and
    // skips. We construct the entry directly with `inert: true`
    // rather than invoking the decorator so the test does not
    // depend on the decorator's own validation order.
    const registry = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ true);
    const service = new BullmqSchedule(registry, baseOptions, fakeLauncher());

    await service.onApplicationBootstrap();

    // The schedule queue IS still built — the service constructs it
    // unconditionally before iterating the registry. What changes is
    // that nothing is installed into it.
    expect(bullmqMock.Queue).toHaveBeenCalledTimes(1);
    expect(bullmqMock.Worker).not.toHaveBeenCalled();
    expect(bullmqMock.upsertJobScheduler).not.toHaveBeenCalled();
    expect(service.installedSchedulerKeys()).toEqual([]);
  });

  it('starts a schedule worker when autoStartWorker=true and bridges schedule fires to JobLauncher.launch', async () => {
    const registry = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const launcher = fakeLauncher();
    const options: ResolvedBullMqModuleOptions = {
      ...baseOptions,
      autoStartWorker: true,
    };
    const service = new BullmqSchedule(registry, options, launcher);

    await service.onApplicationBootstrap();

    expect(bullmqMock.Worker).toHaveBeenCalledTimes(1);
    const [name, _processor, workerOpts] = bullmqMock.Worker.mock.calls[0] ?? [];
    expect(name).toBe(BULLMQ_SCHEDULE_QUEUE_NAME);
    expect(workerOpts).toEqual(
      expect.objectContaining({
        prefix: options.connection.keyPrefix,
        concurrency: 1,
      }),
    );

    const processor = bullmqMock.getWorkerProcessor();
    expect(processor).toBeTypeOf('function');
    await processor?.({
      id: 'repeat:jobA::hourly:1',
      timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
      data: { jobId: 'jobA', scheduleName: 'hourly', methodName: 'method' },
    });

    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(launcher.launch).toHaveBeenCalledWith('jobA', {
      scheduled: true,
      scheduleName: 'hourly',
      scheduledAt: '2026-01-02T03:04:05.000Z',
      scheduleQueueJobId: 'repeat:jobA::hourly:1',
    });
  });

  it('keeps a shared scheduler active when one of two instances shuts down', async () => {
    const registryA = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const registryB = buildRegistry('*/1 * * * * *', 'UTC', /* inert */ false);
    const launcherA = fakeLauncher();
    const launcherB = fakeLauncher();
    const options: ResolvedBullMqModuleOptions = {
      ...baseOptions,
      autoStartWorker: true,
    };
    const instanceA = new BullmqSchedule(registryA, options, launcherA);
    const instanceB = new BullmqSchedule(registryB, options, launcherB);

    await instanceA.onApplicationBootstrap();
    await instanceB.onApplicationBootstrap();

    expect(bullmqMock.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(bullmqMock.sharedSchedulers).toEqual(new Set(['jobA::hourly']));

    await instanceA.onApplicationShutdown();

    expect(bullmqMock.removeJobScheduler).not.toHaveBeenCalled();
    expect(bullmqMock.sharedSchedulers).toEqual(new Set(['jobA::hourly']));

    const instanceBProcessor = bullmqMock.getWorkerProcessor();
    await instanceBProcessor?.({
      id: 'repeat:jobA::hourly:2',
      timestamp: Date.UTC(2026, 0, 2, 3, 4, 6),
      data: { jobId: 'jobA', scheduleName: 'hourly', methodName: 'method' },
    });

    expect(launcherA.launch).not.toHaveBeenCalled();
    expect(launcherB.launch).toHaveBeenCalledWith('jobA', {
      scheduled: true,
      scheduleName: 'hourly',
      scheduledAt: '2026-01-02T03:04:06.000Z',
      scheduleQueueJobId: 'repeat:jobA::hourly:2',
    });
  });
});
