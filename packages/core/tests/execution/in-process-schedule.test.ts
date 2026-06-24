import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { InProcessSchedule } from '../../src/execution/in-process-schedule';
import type { JobLauncher } from '../../src/execution/job-launcher';
import { BatchScheduleRegistry } from '../../src/module/batch-schedule-registry';

function launcher(): JobLauncher & { launch: Mock } {
  return {
    launch: vi.fn(async () => ({
      id: 'execution-1',
      status: 'COMPLETED',
    })),
  } as unknown as JobLauncher & { launch: Mock };
}

function registerSchedule(
  registry: BatchScheduleRegistry,
  overrides: Partial<Parameters<BatchScheduleRegistry['register']>[0]> = {},
): void {
  registry.register({
    jobId: 'import-products',
    scheduleName: 'hourly-import-products',
    methodName: 'scheduledImportProducts',
    cron: '* * * * *',
    timezone: 'UTC',
    inert: false,
    ...overrides,
  });
}

describe('InProcessSchedule', () => {
  let schedule: InProcessSchedule | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    schedule = null;
  });

  afterEach(() => {
    schedule?.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('fires @BatchScheduled entries through JobLauncher.launch without BullMQ', async () => {
    const registry = new BatchScheduleRegistry();
    registerSchedule(registry);
    const jobLauncher = launcher();
    schedule = new InProcessSchedule(registry, jobLauncher);

    schedule.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(jobLauncher.launch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);
    expect(jobLauncher.launch).toHaveBeenCalledWith('import-products', {
      scheduled: true,
      scheduleName: 'hourly-import-products',
      scheduledAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('does not install active launches for inert entries', async () => {
    const registry = new BatchScheduleRegistry();
    registerSchedule(registry, { inert: true });
    const jobLauncher = launcher();
    schedule = new InProcessSchedule(registry, jobLauncher);

    schedule.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(jobLauncher.launch).not.toHaveBeenCalled();
  });

  it('uses skip overlap by default while a previous scheduled launch is running', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new BatchScheduleRegistry();
    registerSchedule(registry, { cron: '* * * * * *' });

    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const jobLauncher = launcher();
    jobLauncher.launch
      .mockImplementationOnce(async () => {
        await first;
        return { id: 'execution-1', status: 'COMPLETED' };
      })
      .mockResolvedValue({ id: 'execution-2', status: 'COMPLETED' });

    schedule = new InProcessSchedule(registry, jobLauncher);
    schedule.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch a queued launch after application shutdown', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new BatchScheduleRegistry();
    registerSchedule(registry, { cron: '* * * * * *', overlap: 'queue' });

    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const jobLauncher = launcher();
    jobLauncher.launch.mockImplementationOnce(async () => {
      await first;
      return { id: 'execution-1', status: 'COMPLETED' };
    });

    schedule = new InProcessSchedule(registry, jobLauncher);
    schedule.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);

    schedule.onApplicationShutdown();
    resolveFirst();
    await first;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(jobLauncher.launch).toHaveBeenCalledTimes(1);
  });
});
