import {
  type ExecutionStrategyContext,
  type IExecutionStrategy,
  type JobDefinition,
  type JobParameters,
  type LaunchResult,
} from '@nest-batch/core';
import { Inject, Injectable, Logger } from '@nestjs/common';


import {
  KafkaRuntimeService,
  KAFKA_STRATEGY_NAME,
} from './kafka-runtime.service';

/**
 * Kafka execution strategy — the `@nest-batch/core`-facing
 * transport that hands a `JobExecution` off to a Kafka `Producer`
 * and lets a `Consumer` process the work.
 *
 * Design:
 *   - The actual Kafka resource ownership (producer / consumer
 *     lifecycle, connection tuning, event bridge) lives in
 *     `KafkaRuntimeService`. This class is a thin adapter that
 *     maps the `IExecutionStrategy` contract to the runtime
 *     service's `launch()` shape.
 *   - Splitting the two lets the runtime service be
 *     independently testable (e.g. a test that wants to drive
 *     the consumer without going through the launcher can
 *     instantiate the runtime service alone), and lets the
 *     strategy class stay as a stable public surface for
 *     `EXECUTION_STRATEGY` consumers.
 *   - The strategy inherits the runtime service's
 *     `name` (`'kafka'`) — the runtime service is the
 *     single source of truth for the strategy name.
 *
 * `name` and `launch()` together comprise the contract:
 *   - `name = 'kafka'` — replaces any stub so log lines and
 *     boundary reports can tell the real implementation from
 *     the skeleton.
 *   - `launch()` produces exactly one Kafka message per step
 *     (or, for chunk steps with `partitions.count >= 2` —
 *     T9 / T-AC-3 second half — one message per partition,
 *     each carrying a distinct `partitionIndex`). It NEVER
 *     produces one message per row/chunk. Returns
 *     `{ kind: 'enqueued', queueJobId }`. The launch is
 *     fire-and-forget; the launcher re-resolves the
 *     canonical `JobExecution` from the repository.
 */
@Injectable()
export class KafkaExecutionStrategy implements IExecutionStrategy {
  /** Strategy name. Mirrors the runtime service's name. */
  readonly name = KAFKA_STRATEGY_NAME;

  private readonly logger = new Logger(KafkaExecutionStrategy.name);

  constructor(
    @Inject(KafkaRuntimeService)
    private readonly runtime: KafkaRuntimeService,
  ) {}

  /**
   * Produce the work and return the Kafka message offset. The DB
   * execution row was created by the launcher BEFORE this
   * method was called — this method MUST NOT re-create it
   * (the launcher's atomic create-or-lock would race with us).
   *
   * Throws on producer failure. The launcher propagates the
   * error to its caller; the canonical `JobExecution` row
   * stays in `STARTING` and the host's recovery path is
   * responsible for transitioning it.
   */
  async launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    return this.runtime.launch(job, params, ctx);
  }
}


