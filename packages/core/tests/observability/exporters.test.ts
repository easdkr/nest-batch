import { describe, expect, test, vi } from 'vitest';

import {
  BATCH_EVENT,
  CompositeBatchObserver,
  JsonLogBatchObserver,
  PrometheusBatchMetricsObserver,
  type BatchEvent,
} from '../../src/observability';

const event: BatchEvent = {
  type: BATCH_EVENT.JOB_COMPLETED,
  timestamp: new Date('2026-01-01T00:00:00Z'),
  jobExecutionId: 'exec-1',
  data: { status: 'COMPLETED' },
};

describe('observability exporters', () => {
  test('CompositeBatchObserver fans out to every observer', async () => {
    const a = { onEvent: vi.fn() };
    const b = { onEvent: vi.fn() };
    await new CompositeBatchObserver([a, b]).onEvent(event);
    expect(a.onEvent).toHaveBeenCalledWith(event);
    expect(b.onEvent).toHaveBeenCalledWith(event);
  });

  test('JsonLogBatchObserver writes serialized event lines', () => {
    const lines: string[] = [];
    new JsonLogBatchObserver({ write: (line) => lines.push(line) }).onEvent(event);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: BATCH_EVENT.JOB_COMPLETED,
      jobExecutionId: 'exec-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  test('PrometheusBatchMetricsObserver counts and renders events', () => {
    const observer = new PrometheusBatchMetricsObserver();
    observer.onEvent(event);
    observer.onEvent({ ...event, type: BATCH_EVENT.JOB_FAILED });
    const snapshot = observer.snapshot();
    expect(snapshot.jobsCompleted).toBe(1);
    expect(snapshot.jobsFailed).toBe(1);
    expect(observer.renderPrometheus()).toContain('nest_batch_events_total');
  });
});
