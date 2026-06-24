import type { ExecutionContext, ExecutionScope, JobParameters } from '../repository/types';

type MaybePromise<T> = T | Promise<T>;

/**
 * Reads one item at a time. Returns `null` to signal EOF.
 * For async iteration, use `AsyncIterable.read()` (not yet supported in MVP).
 */
export interface ItemExecutionContext {
  readonly jobExecutionId: string;
  readonly stepExecutionId: string;
  readonly stepName: string;
  readonly jobParameters: JobParameters;
  readonly chunkIndex?: number;
  getExecutionContext(): Promise<ExecutionContext>;
  saveExecutionContext(ctx: ExecutionContext): Promise<void>;
}

export interface ItemReader<T = unknown> {
  read(ctx?: ItemExecutionContext): Promise<T | null>;
}

/**
 * Processes one item. Returns `null`/`undefined` to filter the item out of the chunk.
 * Throws to indicate the item should be skipped (via SkipPolicy) or retried (via RetryPolicy).
 */
export interface ItemProcessor<I = unknown, O = unknown> {
  process(item: I, ctx?: ItemExecutionContext): Promise<O | null | undefined>;
}

/**
 * Writes a batch of items. Called once per chunk (after processing).
 *
 * May return a `WriterResult` to report partial success — e.g. a
 * `ProductWriter` that drops duplicate-SKU rows internally. Returning
 * `void` (or `undefined`) means the writer assumed all `items` were
 * persisted; the chunk executor then uses `items.length` as the write
 * count and assumes no per-item skips.
 */
export interface ItemWriter<T = unknown> {
  write(items: T[], ctx?: ItemExecutionContext): Promise<WriterResult | void>;
}

export interface WriterResult {
  written: number;
  skipped: number;
}

/**
 * Optional lifecycle contract for stateful chunk components.
 *
 * The chunk executor passes the step-scoped ExecutionContext to
 * `open()` before the first read, calls `update()` after every committed
 * chunk, persists the returned or mutated context, and calls `close()`
 * before the step returns. Errors from any hook fail the step.
 */
export interface ItemStream {
  open(context: ExecutionContext): MaybePromise<void>;
  update(context: ExecutionContext): MaybePromise<ExecutionContext | void>;
  close(): MaybePromise<void>;
}

/**
 * Tasklet context: lets the tasklet access the execution context for
 * cross-chunk state.
 */
export interface TaskletContext {
  readonly jobExecutionId: string;
  readonly stepExecutionId: string;
  readonly jobParameters: JobParameters;
  getExecutionContext(): Promise<ExecutionContext>;
  saveExecutionContext(ctx: ExecutionContext): Promise<void>;
}

/**
 * Tasklet: a single-execution step (no chunk loop).
 * Return value is informational; throws signal failure.
 */
export interface Tasklet {
  execute(ctx: TaskletContext): Promise<unknown>;
}
