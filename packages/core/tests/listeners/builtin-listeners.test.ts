/**
 * Tests for the reference built-in listeners (Logging / Metrics / Timing).
 *
 * The goal is to lock in the public contract of each class:
 *
 *  - `LoggingListener` — every lifecycle / skip callback resolves without
 *    throwing, regardless of input shape.
 *  - `MetricsListener` — `afterStep` records per-step counts and
 *    `getCounts` returns them.
 *  - `TimingListener` — `afterStep` returns a non-negative millisecond
 *    duration that is at least the wall-clock time elapsed since
 *    `beforeStep` was called.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  LoggingListener,
  MetricsListener,
  TimingListener,
} from '../../src/listeners/builtin-listeners';

describe('LoggingListener', () => {
  test('1) every lifecycle / skip callback resolves without throwing', async () => {
    const listener = new LoggingListener();
    // Silence the actual logger output — we only care that nothing throws.
    const logSpy = vi.spyOn((listener as unknown as { logger: { log: (...a: unknown[]) => void } }).logger, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn((listener as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn').mockImplementation(() => undefined);

    // Job
    await expect(
      listener.beforeJob({ jobExecutionId: 'job-1' }),
    ).resolves.toBeUndefined();
    await expect(
      listener.afterJob({ jobExecutionId: 'job-1' }, { status: 'COMPLETED' }),
    ).resolves.toBeUndefined();

    // Step
    await expect(
      listener.beforeStep({ jobExecutionId: 'job-1', stepExecutionId: 'step-1' }),
    ).resolves.toBeUndefined();
    await expect(
      listener.afterStep(
        { jobExecutionId: 'job-1', stepExecutionId: 'step-1' },
        { status: 'COMPLETED', exitCode: 'COMPLETED' },
      ),
    ).resolves.toBeUndefined();

    // Skip
    await expect(
      listener.onSkipInRead(new Error('boom'), { id: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      listener.onSkipInProcess({ id: 2 }, new Error('boom')),
    ).resolves.toBeUndefined();
    await expect(
      listener.onSkipInWrite([{ id: 3 }], new Error('boom')),
    ).resolves.toBeUndefined();

    // Every callback should have produced at least one log/warn entry.
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls.length + warnSpy.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
});

describe('MetricsListener', () => {
  test('2) afterStep accumulates counts and getCounts returns them', async () => {
    const listener = new MetricsListener();
    const stepExecutionId = 'step-exec-42';

    // Pre-condition: no counts yet.
    expect(listener.getCounts(stepExecutionId)).toBeUndefined();

    await listener.afterStep(
      { stepExecutionId },
      { readCount: 5, writeCount: 5, skipCount: 1, status: 'COMPLETED' },
    );

    expect(listener.getCounts(stepExecutionId)).toEqual({
      read: 5,
      write: 5,
      skip: 1,
    });
  });

  test('3) afterStep defaults missing count fields to 0', async () => {
    const listener = new MetricsListener();
    const stepExecutionId = 'step-exec-partial';

    await listener.afterStep(
      { stepExecutionId },
      { status: 'COMPLETED' },
    );

    expect(listener.getCounts(stepExecutionId)).toEqual({
      read: 0,
      write: 0,
      skip: 0,
    });
  });
});

describe('TimingListener', () => {
  test('4) afterStep returns a duration in ms (>= sleep window)', async () => {
    const listener = new TimingListener();
    const stepExecutionId = 'step-exec-timed';

    await listener.beforeStep({ stepExecutionId });
    // Sleep for 10ms so the measured duration has a non-trivial lower bound.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const duration = await listener.afterStep({ stepExecutionId });

    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(10);
  });

  test('5) afterStep returns 0 when no matching beforeStep was recorded', async () => {
    const listener = new TimingListener();

    const duration = await listener.afterStep({ stepExecutionId: 'never-seen' });

    expect(duration).toBe(0);
  });
});
