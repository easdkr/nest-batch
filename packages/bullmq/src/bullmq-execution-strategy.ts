import { Injectable, Logger } from '@nestjs/common';

import {
  type ExecutionStrategyContext,
  type IExecutionStrategy,
  type JobDefinition,
  type JobParameters,
  type LaunchResult,
} from '@nest-batch/core';

import {
  BullmqRuntimeService,
  BULLMQ_STRATEGY_NAME,
} from './bullmq-runtime.service';

/**
 * BullMQ execution strategy — the `@nest-batch/core`-facing
 * transport that hands a `JobExecution` off to a BullMQ `Queue`
 * and lets a `Worker` process the work.
 *
 * Design (T18):
 *   - The actual BullMQ resource ownership (queue / worker /
 *     queue-events lifecycle, connection tuning, event bridge)
 *     lives in `BullmqRuntimeService`. This class is a thin
 *     adapter that maps the `IExecutionStrategy` contract to
 *     the runtime service's `launch()` shape.
 *   - Splitting the two lets the runtime service be
 *     independently testable (e.g. a test that wants to drive
 *     the worker without going through the launcher can
 *     instantiate the runtime service alone), and lets the
 *     strategy class stay as a stable public surface for
 *     `EXECUTION_STRATEGY` consumers.
 *   - The strategy inherits the runtime service's
 *     `name` (`'bullmq'`) — the runtime service is the
 *     single source of truth for the strategy name.
 *
 * `name` and `launch()` together comprise the T18 contract:
 *   - `name = 'bullmq'` — replaces the T17 stub's
 *     `'bullmq-stub'` so log lines and boundary reports can
 *     tell the real implementation from the skeleton.
 *   - `launch()` enqueues exactly one BullMQ job per step
 *     (one job per step, NEVER one job per row/chunk) and
 *     returns `{ kind: 'enqueued', queueJobId }`. The launch
 *     is fire-and-forget; the launcher re-resolves the
 *     canonical `JobExecution` from the repository.
 */
@Injectable()
export class BullMqExecutionStrategy implements IExecutionStrategy {
  /** Strategy name. Mirrors the runtime service's name. */
  readonly name = BULLMQ_STRATEGY_NAME;

  private readonly logger = new Logger(BullMqExecutionStrategy.name);

  constructor(private readonly runtime: BullmqRuntimeService) {}

  /**
   * Enqueue the work and return the BullMQ job id. The DB
   * execution row was created by the launcher BEFORE this
   * method was called — this method MUST NOT re-create it
   * (the launcher's atomic create-or-lock would race with us).
   *
   * Throws on producer failure. The launcher propagates the
   * error to its caller; the canonical `JobExecution` row
   * stays in `STARTING` and the host's recovery path is
   * responsible for transitioning it (a future task will
   * wire a "dead letter" cleanup).
   */
  async launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    return this.runtime.launch(job, params, ctx);
  }
}

/**
 * Re-export the canonical `name` for tests that want to assert
 * on it without importing the runtime service directly.
 */
export { BULLMQ_STRATEGY_NAME };
