import type { JsonValue } from '../core/execution-context/json-value';

/**
 * Event type constants emitted by the JobExecutor / step executors.
 *
 * Naming follows `<domain>.<entity>.<verb-past-tense>` so downstream
 * consumers can subscribe via dot-separated filter strings.
 */
export const BATCH_EVENT = {
  JOB_STARTED: 'nest-batch.job.started',
  JOB_COMPLETED: 'nest-batch.job.completed',
  JOB_FAILED: 'nest-batch.job.failed',
  STEP_STARTED: 'nest-batch.step.started',
  STEP_COMPLETED: 'nest-batch.step.completed',
  STEP_FAILED: 'nest-batch.step.failed',
  CHUNK_PROCESSED: 'nest-batch.chunk.processed',
  ITEM_SKIPPED: 'nest-batch.item.skipped',
  ITEM_RETRIED: 'nest-batch.item.retried',
} as const;

export type BatchEventType = (typeof BATCH_EVENT)[keyof typeof BATCH_EVENT];

/**
 * Single, normalized event payload. `data` is intentionally typed as
 * `JsonValue` so observers can ship events over any transport (HTTP,
 * JSON log line, message queue) without further conversion.
 *
 * - `jobExecutionId` is always present.
 * - `stepExecutionId` is present for STEP_*, CHUNK_*, and ITEM_*
 *   events; absent for JOB_* events that fire outside a step context
 *   (currently the JOB_STARTED / JOB_COMPLETED / JOB_FAILED trio).
 */
export interface BatchEvent {
  type: BatchEventType;
  timestamp: Date;
  jobExecutionId: string;
  stepExecutionId?: string;
  data: JsonValue;
}

/**
 * Observer contract for batch lifecycle events. Implementations may
 * emit logs, push to a queue, or aggregate metrics. The executor
 * awaits `onEvent` so a slow observer blocks step transitions — this
 * is intentional: per the plan, exporters are out of scope, and the
 * default observer is a no-op.
 */
export interface BatchObserver {
  onEvent(event: BatchEvent): void | Promise<void>;
}

/**
 * Default observer used when none is supplied. Discards every event.
 * Useful as a sentinel default that satisfies the interface without
 * doing any I/O.
 */
export class NoopBatchObserver implements BatchObserver {
  async onEvent(_event: BatchEvent): Promise<void> {
    // intentional no-op
  }
}
