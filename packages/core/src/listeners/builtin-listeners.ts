/**
 * Reference built-in listeners — drop-in `Injectable` classes that mirror the
 * Spring Batch conventions (logging, metrics, timing). Each listener exposes
 * the lifecycle methods consumed by `ListenerInvoker` and uses the canonical
 * `ResolverMap` key format (`${phase}:${kind}:${name}`), so a user can simply
 * instantiate one of these classes and register the bound methods under the
 * desired phase/kind pairs.
 *
 * The classes are intentionally framework-agnostic — they do not depend on
 * the execution pipeline, the `ResolverMap` shape, or any module wiring. They
 * only depend on `@nestjs/common` for `Logger` / `Injectable`.
 */
import { Injectable, Logger } from '@nestjs/common';

// ---------------------------------------------------------------------------
// LoggingListener
// ---------------------------------------------------------------------------

/**
 * Emits a one-line `log` / `warn` entry for every lifecycle event. The method
 * names match the 7 `LifecyclePhaseKind` values plus the 3 `SkipSubKind`
 * variants, so callers can register any of them under a `ResolverMap` key
 * like `before:step:LoggingListener` and the invoker will dispatch correctly.
 */
@Injectable()
export class LoggingListener {
  private readonly logger = new Logger(LoggingListener.name);

  // -- Job -----------------------------------------------------------------
  async beforeJob(ctx: { jobExecutionId: string }): Promise<void> {
    this.logger.log(`Job ${ctx.jobExecutionId} starting`);
  }

  async afterJob(
    ctx: { jobExecutionId: string },
    result: { status: string },
  ): Promise<void> {
    this.logger.log(`Job ${ctx.jobExecutionId} ${result.status}`);
  }

  // -- Step ----------------------------------------------------------------
  async beforeStep(ctx: {
    jobExecutionId: string;
    stepExecutionId: string;
  }): Promise<void> {
    this.logger.log(`Step ${ctx.stepExecutionId} starting`);
  }

  async afterStep(
    ctx: { jobExecutionId: string; stepExecutionId: string },
    result: { status: string; exitCode: string },
  ): Promise<void> {
    this.logger.log(
      `Step ${ctx.stepExecutionId} ${result.status} (${result.exitCode})`,
    );
  }

  // -- Skip ----------------------------------------------------------------
  async onSkipInRead(err: unknown, item: unknown): Promise<void> {
    this.logger.warn(
      `Skipped read: ${(err as Error).message} (item=${String(item)})`,
    );
  }

  async onSkipInProcess(item: unknown, err: unknown): Promise<void> {
    this.logger.warn(
      `Skipped process: ${(err as Error).message} (item=${String(item)})`,
    );
  }

  async onSkipInWrite(items: unknown[], err: unknown): Promise<void> {
    this.logger.warn(
      `Skipped write of ${items.length} items: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// MetricsListener
// ---------------------------------------------------------------------------

/**
 * Per-step read / write / skip counters. The counts are keyed by
 * `stepExecutionId`, so multiple step executions within the same job are
 * tracked independently. Callers can read the latest counts via
 * `getCounts(stepExecutionId)`.
 */
@Injectable()
export class MetricsListener {
  private readonly stepCounts = new Map<
    string,
    { read: number; write: number; skip: number }
  >();

  /**
   * Store the counts reported by the step result. Missing fields default to 0
   * so a partial result (e.g. a tasklet step that has no read/write/skip
   * counts) does not pollute the metric with `NaN`/`undefined`.
   */
  async afterStep(
    ctx: { stepExecutionId: string },
    result: {
      readCount?: number;
      writeCount?: number;
      skipCount?: number;
      status: string;
    },
  ): Promise<void> {
    this.stepCounts.set(ctx.stepExecutionId, {
      read: result.readCount ?? 0,
      write: result.writeCount ?? 0,
      skip: result.skipCount ?? 0,
    });
  }

  /** Returns the latest recorded counts for the given step, or `undefined` if
   *  the step has not been observed yet. */
  getCounts(
    stepExecutionId: string,
  ): { read: number; write: number; skip: number } | undefined {
    return this.stepCounts.get(stepExecutionId);
  }
}

// ---------------------------------------------------------------------------
// TimingListener
// ---------------------------------------------------------------------------

/**
 * Records the wall-clock duration of each step. `beforeStep` captures
 * `Date.now()`; `afterStep` returns the elapsed milliseconds (or 0 if no
 * matching `beforeStep` was observed — this keeps the listener idempotent
 * even when invoked out of order, e.g. after a process restart that replayed
 * a partial log).
 */
@Injectable()
export class TimingListener {
  private readonly startTimes = new Map<string, number>();

  async beforeStep(ctx: { stepExecutionId: string }): Promise<void> {
    this.startTimes.set(ctx.stepExecutionId, Date.now());
  }

  async afterStep(ctx: { stepExecutionId: string }): Promise<number> {
    const start = this.startTimes.get(ctx.stepExecutionId);
    if (start !== undefined) {
      return Date.now() - start;
    }
    return 0;
  }
}
