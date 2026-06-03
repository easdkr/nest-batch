import type { ExecutionContext, ExecutionScope } from '../repository/types';

/**
 * Reads one item at a time. Returns `null` to signal EOF.
 * For async iteration, use `AsyncIterable.read()` (not yet supported in MVP).
 */
export interface ItemReader<T = unknown> {
  read(): Promise<T | null>;
}

/**
 * Processes one item. Returns `null`/`undefined` to filter the item out of the chunk.
 * Throws to indicate the item should be skipped (via SkipPolicy) or retried (via RetryPolicy).
 */
export interface ItemProcessor<I = unknown, O = unknown> {
  process(item: I): Promise<O | null | undefined>;
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
  write(items: T[]): Promise<WriterResult | void>;
}

export interface WriterResult {
  written: number;
  skipped: number;
}

/**
 * Tasklet context: lets the tasklet access the execution context for
 * cross-chunk state.
 */
export interface TaskletContext {
  readonly jobExecutionId: string;
  readonly stepExecutionId: string;
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
