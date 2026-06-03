import { describe, expect, test } from 'vitest';
import {
  BATCH_EVENT,
  NoopBatchObserver,
  type BatchEvent,
  type BatchObserver,
} from '../../src/observability';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import {
  RefKind,
  type JobDefinition,
  type TaskletRef,
  type TaskletStepDefinition,
} from '../../src/core/ir';

// ---------------------------------------------------------------------------
// Test 4 fixture helpers (duplicated from job-executor.test.ts to keep the
// observability suite self-contained; the public package API is the
// integration target here, not JobExecutor's per-test wiring).
// ---------------------------------------------------------------------------

function makeJobDef(
  id: string,
  steps: Record<string, TaskletStepDefinition>,
  startStepId?: string,
): JobDefinition {
  return {
    id,
    steps,
    startStepId: startStepId ?? Object.keys(steps)[0]!,
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

function makeTaskletStep(stepId: string, fn: () => Promise<unknown> | unknown): TaskletStepDefinition {
  const ref: TaskletRef = {
    kind: RefKind.BuilderLambda,
    fn: fn as TaskletRef['fn'],
  };
  return { kind: 'tasklet', id: stepId, tasklet: ref, listeners: [] };
}

/**
 * Capturing observer: pushes every event to an internal array. Used by
 * Test 4 to assert the JobExecutor's lifecycle contract end-to-end.
 */
class CapturingObserver implements BatchObserver {
  readonly events: BatchEvent[] = [];
  onEvent(event: BatchEvent): void {
    this.events.push(event);
  }
}

describe('observability: event-types', () => {
  // -------------------------------------------------------------------------
  // 1) Constants: BATCH_EVENT frozen table has the expected keys/values.
  //    A typo here would silently break every consumer that filters on
  //    the string, so we pin each entry.
  // -------------------------------------------------------------------------
  test('1) BATCH_EVENT constants have the expected values', () => {
    expect(BATCH_EVENT.JOB_STARTED).toBe('nest-batch.job.started');
    expect(BATCH_EVENT.JOB_COMPLETED).toBe('nest-batch.job.completed');
    expect(BATCH_EVENT.JOB_FAILED).toBe('nest-batch.job.failed');
    expect(BATCH_EVENT.STEP_STARTED).toBe('nest-batch.step.started');
    expect(BATCH_EVENT.STEP_COMPLETED).toBe('nest-batch.step.completed');
    expect(BATCH_EVENT.STEP_FAILED).toBe('nest-batch.step.failed');
    expect(BATCH_EVENT.CHUNK_PROCESSED).toBe('nest-batch.chunk.processed');
    expect(BATCH_EVENT.ITEM_SKIPPED).toBe('nest-batch.item.skipped');
    expect(BATCH_EVENT.ITEM_RETRIED).toBe('nest-batch.item.retried');
  });

  // -------------------------------------------------------------------------
  // 2) Type-level: BatchEvent has all four required fields. We do this
  //    at runtime by building a fully-populated BatchEvent literal;
  //    TypeScript will fail to compile if a required field is missing.
  // -------------------------------------------------------------------------
  test('2) BatchEvent interface compiles with required fields', () => {
    const ev: BatchEvent = {
      type: BATCH_EVENT.JOB_STARTED,
      timestamp: new Date(),
      jobExecutionId: 'job-1',
      data: { foo: 'bar' },
    };
    expect(ev.type).toBe(BATCH_EVENT.JOB_STARTED);
    expect(ev.timestamp).toBeInstanceOf(Date);
    expect(ev.jobExecutionId).toBe('job-1');
    expect(ev.data).toEqual({ foo: 'bar' });
    // stepExecutionId is optional.
    expect(ev.stepExecutionId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3) NoopBatchObserver must not throw and must resolve.
  // -------------------------------------------------------------------------
  test('3) NoopBatchObserver.onEvent() resolves without throwing', async () => {
    const obs = new NoopBatchObserver();
    await expect(
      obs.onEvent({
        type: BATCH_EVENT.JOB_STARTED,
        timestamp: new Date(),
        jobExecutionId: 'job-1',
        data: null,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4) Integration: a real JobExecutor with a tiny tasklet job emits the
  //    expected lifecycle events to a custom observer (JOB_STARTED,
  //    STEP_STARTED, STEP_COMPLETED, JOB_COMPLETED).
  // -------------------------------------------------------------------------
  test('4) JobExecutor emits lifecycle events to a custom observer', async () => {
    const repository = new InMemoryJobRepository();
    const transactionManager = new InMemoryTransactionManager();
    const listenerInvoker = new ListenerInvoker();
    const taskletExecutor = new TaskletStepExecutor();
    const chunkExecutor = new ChunkStepExecutor();
    const flowEvaluator = new FlowEvaluator();
    const observer = new CapturingObserver();

    const executor = new JobExecutor(
      repository,
      transactionManager,
      taskletExecutor,
      chunkExecutor,
      listenerInvoker,
      flowEvaluator,
      observer,
    );

    const jobDef = makeJobDef('obs-job', {
      s1: makeTaskletStep('s1', async () => 'ok'),
    });
    const instance = await repository.getOrCreateJobInstance('obs-job', 'k-1');
    const execution = await repository.createJobExecution(instance.id, {});
    await executor.execute(execution, jobDef);

    const types = observer.events.map((e) => e.type);
    // First a JOB_STARTED, then a STEP_STARTED → STEP_COMPLETED pair,
    // then a JOB_COMPLETED. Anything else (a duplicate, a missing
    // event) fails the test.
    expect(types).toEqual([
      BATCH_EVENT.JOB_STARTED,
      BATCH_EVENT.STEP_STARTED,
      BATCH_EVENT.STEP_COMPLETED,
      BATCH_EVENT.JOB_COMPLETED,
    ]);

    // Every event must reference the same jobExecutionId.
    for (const ev of observer.events) {
      expect(ev.jobExecutionId).toBe(execution.id);
      expect(ev.timestamp).toBeInstanceOf(Date);
    }

    // STEP_* events must carry a stepExecutionId; JOB_* events must not.
    const stepStarted = observer.events.find((e) => e.type === BATCH_EVENT.STEP_STARTED)!;
    const jobStarted = observer.events.find((e) => e.type === BATCH_EVENT.JOB_STARTED)!;
    expect(stepStarted.stepExecutionId).toBeTruthy();
    expect(jobStarted.stepExecutionId).toBeUndefined();
  });
});
