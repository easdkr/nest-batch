import { Injectable } from '@nestjs/common';
import {
  Batch,
  BatchScheduled,
  FlowExecutionStatus,
  type JobParameters,
  type ListenerContext,
} from '@nest-batch/core';

@Injectable()
@Batch.Jobable({ id: 'multi-step-demo', allowDuplicateInstances: true })
export class MultiStepDemoJob {
  private readonly defaultItems = [1, 2, 3];
  private items: number[] = [];
  private cursor = 0;
  private events: string[] = [];

  getEvents(): string[] {
    return [...this.events];
  }

  @BatchScheduled('*/30 * * * * *', {
    name: 'every-30-seconds',
    timezone: 'UTC',
    overlap: 'skip',
  })
  scheduledRun(): void {
    // Marker method for schedule metadata.
  }

  @Batch.BeforeJob()
  beforeJob(ctx: ListenerContext): void {
    this.items = this.resolveItems(ctx.jobParameters);
    this.cursor = 0;
    this.events = [
      `job:start:${this.items.join(',')}`,
      ...(ctx.jobParameters?.scheduled === true
        ? [`schedule:${String(ctx.jobParameters.scheduleName ?? '<unknown>')}`]
        : []),
    ];
  }

  @Batch.Stepable({ id: 'prepare-items' })
  @Batch.Tasklet()
  async prepareItems(): Promise<{ count: number }> {
    this.events.push(`step:prepare:${this.items.length}`);
    return { count: this.items.length };
  }

  @Batch.Stepable({ id: 'load-items', chunkSize: 2 })
  loadItems(): void {
    // Marker method for chunk step metadata.
  }

  @Batch.ItemReader()
  async read(): Promise<number | null> {
    const item = this.items[this.cursor++] ?? null;
    this.events.push(item === null ? 'reader:eof' : `reader:${item}`);
    return item;
  }

  @Batch.ItemProcessor()
  async process(item: number): Promise<number> {
    const processed = item * 10;
    this.events.push(`processor:${item}->${processed}`);
    return processed;
  }

  @Batch.ItemWriter()
  async write(items: number[]): Promise<void> {
    this.events.push(`writer:${items.join(',')}`);
  }

  @Batch.OnTransition({
    fromStep: 'prepare-items',
    onStatus: FlowExecutionStatus.COMPLETED,
    toStep: 'load-items',
  })
  afterPrepareItems(): void {
    // Marker method for flow metadata.
  }

  @Batch.AfterJob()
  afterJob(_ctx: ListenerContext, result?: { status?: string }): void {
    this.events.push(`job:done:${result?.status ?? 'UNKNOWN'}`);
  }

  private resolveItems(params: JobParameters | undefined): number[] {
    const rawItems = params?.items;
    if (Array.isArray(rawItems)) {
      const parsed = rawItems
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
      if (parsed.length > 0) return parsed;
    }
    return [...this.defaultItems];
  }
}
