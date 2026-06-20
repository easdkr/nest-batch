import { BATCH_EVENT, type BatchEvent, type BatchObserver } from './event-types';

export class CompositeBatchObserver implements BatchObserver {
  constructor(private readonly observers: readonly BatchObserver[]) {}

  async onEvent(event: BatchEvent): Promise<void> {
    await Promise.all(this.observers.map((observer) => observer.onEvent(event)));
  }
}

export interface JsonLogBatchObserverOptions {
  readonly write?: (line: string) => void;
}

export class JsonLogBatchObserver implements BatchObserver {
  private readonly write: (line: string) => void;

  constructor(options: JsonLogBatchObserverOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
  }

  onEvent(event: BatchEvent): void {
    this.write(
      JSON.stringify({
        ...event,
        timestamp: event.timestamp.toISOString(),
      }),
    );
  }
}

export interface BatchMetricsSnapshot {
  readonly eventsTotal: Readonly<Record<string, number>>;
  readonly jobsStarted: number;
  readonly jobsCompleted: number;
  readonly jobsFailed: number;
  readonly stepsStarted: number;
  readonly stepsCompleted: number;
  readonly stepsFailed: number;
  readonly chunksProcessed: number;
  readonly itemsSkipped: number;
  readonly itemsRetried: number;
}

export class PrometheusBatchMetricsObserver implements BatchObserver {
  private readonly eventsTotal = new Map<string, number>();

  onEvent(event: BatchEvent): void {
    this.increment(event.type);
  }

  snapshot(): BatchMetricsSnapshot {
    return {
      eventsTotal: Object.fromEntries(this.eventsTotal.entries()),
      jobsStarted: this.count(BATCH_EVENT.JOB_STARTED),
      jobsCompleted: this.count(BATCH_EVENT.JOB_COMPLETED),
      jobsFailed: this.count(BATCH_EVENT.JOB_FAILED),
      stepsStarted: this.count(BATCH_EVENT.STEP_STARTED),
      stepsCompleted: this.count(BATCH_EVENT.STEP_COMPLETED),
      stepsFailed: this.count(BATCH_EVENT.STEP_FAILED),
      chunksProcessed: this.count(BATCH_EVENT.CHUNK_PROCESSED),
      itemsSkipped: this.count(BATCH_EVENT.ITEM_SKIPPED),
      itemsRetried: this.count(BATCH_EVENT.ITEM_RETRIED),
    };
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP nest_batch_events_total Total batch lifecycle events.',
      '# TYPE nest_batch_events_total counter',
    ];
    for (const [type, count] of [...this.eventsTotal.entries()].sort()) {
      lines.push(`nest_batch_events_total{type="${escapeLabel(type)}"} ${count}`);
    }
    const snapshot = this.snapshot();
    lines.push('# HELP nest_batch_jobs_completed_total Completed jobs.');
    lines.push('# TYPE nest_batch_jobs_completed_total counter');
    lines.push(`nest_batch_jobs_completed_total ${snapshot.jobsCompleted}`);
    lines.push('# HELP nest_batch_jobs_failed_total Failed jobs.');
    lines.push('# TYPE nest_batch_jobs_failed_total counter');
    lines.push(`nest_batch_jobs_failed_total ${snapshot.jobsFailed}`);
    return `${lines.join('\n')}\n`;
  }

  private increment(type: string): void {
    this.eventsTotal.set(type, this.count(type) + 1);
  }

  private count(type: string): number {
    return this.eventsTotal.get(type) ?? 0;
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
