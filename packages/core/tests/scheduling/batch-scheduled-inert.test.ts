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
 *   3. Runtime scheduler adapters honour the flag at scheduling
 *      time. Adapter-specific suites verify that runtime side; this
 *      file asserts the *decorator* side of the contract (point 1 + 2
 *      above) and the `BatchScheduleRegistry` entry it produces
 *      (point 3 from the registry's side).
 *
 * The runtime-scheduler side of point 3 belongs to adapter packages;
 * the contract intentionally keeps core dependency-free of scheduler
 * backends.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';

import { NestBatchModule, BatchScheduleRegistry, BATCH_SCHEDULE_REGISTRY } from '../../src/module';
import { InProcessAdapter } from '../../src/adapters/in-process.adapter';
import type { BatchAdapter, BatchAdaptersConfig } from '../../src/module/adapter';
import {
  EXECUTION_STRATEGY,
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '../../src/module/tokens';
import { JobRepository } from '../../src/core/repository/job-repository';
import type {
  JobInstance,
  JobExecution,
  JobExecutionPatch,
  JobParameters,
  StepExecution,
  StepExecutionPatch,
  ExecutionContext,
  ExecutionScope,
} from '../../src/core/repository/types';
import { TransactionManager } from '../../src/core/transaction/transaction-manager';
import { Jobable, Stepable, Tasklet } from '../../src/decorators';
import { BATCH_SCHEDULED_OPTIONS, BatchScheduled } from '../../src/scheduling/batch-scheduled';

// --- Common fixtures -------------------------------------------------------

const VALID_CRON = '*/5 * * * *';
const VALID_TIMEZONE = 'UTC';
const VALID_NAME = 'inert-job';

function makeOptions(): { name: string; timezone: string } {
  return { name: VALID_NAME, timezone: VALID_TIMEZONE };
}

class StubRepo extends JobRepository {
  async getOrCreateJobInstance(_name: string, _jobKey: string): Promise<JobInstance> {
    throw new Error('not implemented');
  }
  async createJobExecution(_jobInstanceId: string, _params: JobParameters): Promise<JobExecution> {
    throw new Error('not implemented');
  }
  async createExecutionAtomic(
    _name: string,
    _jobKey: string,
    _params: JobParameters,
  ): Promise<JobExecution> {
    throw new Error('not implemented');
  }
  async updateJobExecution(_executionId: string, _patch: JobExecutionPatch): Promise<void> {
    throw new Error('not implemented');
  }
  async getJobExecution(_executionId: string): Promise<JobExecution | null> {
    return null;
  }
  async getRunningJobExecution(_jobInstanceId: string): Promise<JobExecution | null> {
    return null;
  }
  async createStepExecution(_jobExecutionId: string, _stepName: string): Promise<StepExecution> {
    throw new Error('not implemented');
  }
  async updateStepExecution(_stepExecutionId: string, _patch: StepExecutionPatch): Promise<void> {
    throw new Error('not implemented');
  }
  async getStepExecution(_stepExecutionId: string): Promise<StepExecution | null> {
    return null;
  }
  async getExecutionContext(_scope: ExecutionScope): Promise<ExecutionContext> {
    throw new Error('not implemented');
  }
  async saveExecutionContext(
    _scope: ExecutionScope,
    _ctx: ExecutionContext,
    _version?: number,
  ): Promise<void> {
    throw new Error('not implemented');
  }
  async findLatestStepExecution(
    _jobExecutionId: string,
    _stepName: string,
  ): Promise<StepExecution | null> {
    return null;
  }
}

class StubTx extends TransactionManager {
  async withTransaction<T>(fn: (ctx: { isActive: true; id: string }) => Promise<T>): Promise<T> {
    return fn({ isActive: true, id: 'stub-tx' });
  }
}

const stubAdapter: BatchAdapter = {
  name: 'stub',
  module: { module: class StubModule {}, providers: [], exports: [] },
  globalProviders: [
    StubRepo,
    StubTx,
    { provide: JOB_REPOSITORY_TOKEN, useClass: StubRepo },
    { provide: TRANSACTION_MANAGER_TOKEN, useClass: StubTx },
    { provide: EXECUTION_STRATEGY, useValue: { name: 'stub-strategy' } },
    // Test-side workaround: the core module exports
    // BATCH_SCHEDULE_REGISTRY but does not list it in its
    // `providers` array. Aliasing the symbol to the registered
    // BatchScheduleRegistry class via globalProviders satisfies
    // the export contract.
    { provide: BATCH_SCHEDULE_REGISTRY, useExisting: BatchScheduleRegistry },
  ],
};

const stubAdapters: BatchAdaptersConfig = {
  persistence: stubAdapter,
  transport: InProcessAdapter.forRoot(),
};

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
  let setTimeoutSpy: MockInstance<typeof setTimeout> | null = null;
  let setIntervalSpy: MockInstance<typeof setInterval> | null = null;
  let setImmediateSpy: MockInstance<typeof setImmediate> | null = null;
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
    // regardless of the inert flag. Runtime scheduler adapters are
    // the ONLY thing allowed to start timers, and they gate that on
    // the inert flag.
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
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [Job],
    }).compile();

    await moduleRef.init();
    try {
      const registry = moduleRef.get<BatchScheduleRegistry>(BATCH_SCHEDULE_REGISTRY);
      const entry = registry.get('inert-registry-job', VALID_NAME);
      expect(entry).toBeDefined();
      expect(entry!.scheduleName).toBe(VALID_NAME);
      expect(entry!.methodName).toBe('run');
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
      imports: [NestBatchModule.forRoot({ adapters: stubAdapters })],
      providers: [Job],
    }).compile();

    await moduleRef.init();
    try {
      const registry = moduleRef.get<BatchScheduleRegistry>(BATCH_SCHEDULE_REGISTRY);
      const entry = registry.get('live-registry-job', VALID_NAME);
      expect(entry).toBeDefined();
      expect(entry!.inert).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });
});
