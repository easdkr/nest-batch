/**
 * `@BatchScheduled` — inert-mode contract test.
 *
 * Inert mode is the safety valve the framework exposes to disable
 * cron-scheduled jobs without removing the decorator. It is
 * designed for:
 *
 *   - Test environments where timers must NOT leak (e.g. a CI run
 *     that imports a host app with `@BatchScheduled` decorators
 *     would otherwise enqueue real jobs against Redis).
 *   - Local development where a developer wants to "pause" the
 *     scheduler without removing every decorator.
 *   - Disaster recovery — a single env var flips every schedule
 *     off without a deploy.
 *
 * The contract is intentionally narrow:
 *
 *   1. The decorator reads `process.env.BATCH_SCHEDULED_DISABLE`
 *      at *decoration time* and stamps the result on the stored
 *      metadata (`inert: true` / `false`). Reading the env at
 *      decoration time means the value is captured ONCE, at
 *      module load, so a runtime mutation of the env cannot
 *      affect a schedule that has already been registered.
 *   2. The decorator MUST NOT install any timer, interval, or
 *      scheduler registration at decoration time — `inert` is a
 *      pure metadata flag, nothing more.
 *   3. The runtime scheduler (the future `@nest-batch/bullmq`
 *      cron strategy, or a sibling scheduling package) honours
 *      the flag at scheduling time. That behaviour is verified
 *      in `packages/bullmq/tests/scheduling-runtime.test.ts`;
 *      this file asserts the *decorator* side of the contract
 *      (point 1 + 2 above) and the `BatchScheduleRegistry`
 *      entry it produces (point 3 from the registry's side).
 *
 * The runtime-scheduler side of point 3 is tested in
 * `@nest-batch/bullmq` because the runtime lives in that
 * package; the contract intentionally keeps core dependency-free
 * of BullMQ.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';

import { NestBatchModule, BatchScheduleRegistry, BATCH_SCHEDULE_REGISTRY } from '../../src/module';
import { Jobable, Stepable, Tasklet } from '../../src/decorators';
import {
  BATCH_SCHEDULED_OPTIONS,
  BatchScheduled,
} from '../../src/scheduling/batch-scheduled';

// --- Common fixtures -------------------------------------------------------

const VALID_CRON = '*/5 * * * *';
const VALID_TIMEZONE = 'UTC';
const VALID_NAME = 'inert-job';

function makeOptions(): { name: string; timezone: string } {
  return { name: VALID_NAME, timezone: VALID_TIMEZONE };
}

// --- (1) Decorator-side inert flag capture ---------------------------------

describe('@BatchScheduled — inert mode: metadata capture', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.BATCH_SCHEDULED_DISABLE;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BATCH_SCHEDULED_DISABLE;
    } else {
      process.env.BATCH_SCHEDULED_DISABLE = original;
    }
  });

  it('stamps inert: true on the stored metadata when BATCH_SCHEDULED_DISABLE=1', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(true);
  });

  it('stamps inert: false when BATCH_SCHEDULED_DISABLE=0', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '0';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(false);
  });

  it('stamps inert: false when BATCH_SCHEDULED_DISABLE is unset', () => {
    delete process.env.BATCH_SCHEDULED_DISABLE;
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(false);
  });
});

// --- (2) Decorator does NOT install timers ---------------------------------

describe('@BatchScheduled — inert mode: decorator is metadata-only', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn> | null = null;
  let setIntervalSpy: ReturnType<typeof vi.spyOn> | null = null;
  let setImmediateSpy: ReturnType<typeof vi.spyOn> | null = null;
  let original: string | undefined;

  beforeEach(() => {
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    original = process.env.BATCH_SCHEDULED_DISABLE;
  });

  afterEach(() => {
    setTimeoutSpy?.mockRestore();
    setIntervalSpy?.mockRestore();
    setImmediateSpy?.mockRestore();
    setTimeoutSpy = null;
    setIntervalSpy = null;
    setImmediateSpy = null;
    if (original === undefined) {
      delete process.env.BATCH_SCHEDULED_DISABLE;
    } else {
      process.env.BATCH_SCHEDULED_DISABLE = original;
    }
  });

  it('does not call setTimeout when the decorator is applied with BATCH_SCHEDULED_DISABLE=1', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not call setInterval when the decorator is applied with BATCH_SCHEDULED_DISABLE=1', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('does not call setImmediate when the decorator is applied with BATCH_SCHEDULED_DISABLE=1', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    expect(setImmediateSpy).not.toHaveBeenCalled();
  });

  it('does not call setTimeout / setInterval even when BATCH_SCHEDULED_DISABLE=0 (default mode)', () => {
    // The contract is broader: the decorator is metadata-only
    // regardless of the inert flag. The runtime scheduler (in
    // `@nest-batch/bullmq`) is the ONLY thing allowed to start
    // timers, and it gates that on the inert flag.
    process.env.BATCH_SCHEDULED_DISABLE = '0';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});

// --- (3) Registry propagates the inert flag --------------------------------

describe('@BatchScheduled — inert mode: registry propagates the flag', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.BATCH_SCHEDULED_DISABLE;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BATCH_SCHEDULED_DISABLE;
    } else {
      process.env.BATCH_SCHEDULED_DISABLE = original;
    }
  });

  it('BatchScheduleRegistry records inert: true when the env is set to 1', async () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    @Jobable({ id: 'inert-registry-job' })
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}

      @Stepable({ id: 's1' })
      @Tasklet()
      async step(): Promise<void> {
        return;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [Job],
    }).compile();

    await moduleRef.init();
    try {
      const registry = moduleRef.get<BatchScheduleRegistry>(BATCH_SCHEDULE_REGISTRY);
      const entry = registry.get('inert-registry-job', 'run');
      expect(entry).toBeDefined();
      expect(entry!.inert).toBe(true);
      expect(entry!.cron).toBe(VALID_CRON);
      expect(entry!.timezone).toBe(VALID_TIMEZONE);
    } finally {
      await moduleRef.close();
    }
  });

  it('BatchScheduleRegistry records inert: false when the env is unset', async () => {
    delete process.env.BATCH_SCHEDULED_DISABLE;
    @Jobable({ id: 'live-registry-job' })
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}

      @Stepable({ id: 's1' })
      @Tasklet()
      async step(): Promise<void> {
        return;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [Job],
    }).compile();

    await moduleRef.init();
    try {
      const registry = moduleRef.get<BatchScheduleRegistry>(BATCH_SCHEDULE_REGISTRY);
      const entry = registry.get('live-registry-job', 'run');
      expect(entry).toBeDefined();
      expect(entry!.inert).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });
});
