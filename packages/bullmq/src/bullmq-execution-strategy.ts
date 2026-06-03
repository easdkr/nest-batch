import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  JobStatus,
  type ExecutionStrategyContext,
  type IExecutionStrategy,
  type LaunchResult,
} from '@nest-batch/core';
import type { JobDefinition } from '@nest-batch/core';
import type { JobParameters } from '@nest-batch/core';

import {
  BULLMQ_MODULE_OPTIONS,
  type BullMqModuleOptions,
} from './module-options';

/**
 * BullMQ execution strategy — the transport that hands a `JobExecution`
 * off to a BullMQ `Queue` and lets a `Worker` process the work.
 *
 * Task 17 (this file) is the **skeleton**: the strategy is registered
 * against the `@nest-batch/core` `EXECUTION_STRATEGY` token and its
 * `launch()` method returns a placeholder
 * `{ kind: 'completed', status: 'COMPLETED' }` `LaunchResult` without
 * touching Redis. The real enqueue / worker lifecycle is implemented
 * in Task 18. Marking this as a stub is intentional — it lets host
 * apps wire `BullmqBatchModule` into the Nest graph end-to-end and
 * validates that the token-binding plumbing works, without
 * prematurely committing to queue-naming, partition-routing, or
 * scheduler semantics that T18 will define.
 *
 * Why a class and not a plain object?
 *   `IExecutionStrategy` is implemented as a class so that:
 *     - the strategy can be DI-resolved with its own options bag
 *       (`BULLMQ_MODULE_OPTIONS`) injected,
 *     - unit tests can construct a strategy with a stub options bag,
 *     - T18 can extend the class with real queue/worker/factory
 *       wiring without breaking existing call sites (the public
 *       class name + DI token are the stable contract).
 *
 * Why does `launch()` return `{ kind: 'completed' }` instead of
 * `{ kind: 'enqueued' }` in the stub?
 *   The T17 contract is "launch returns *a* `LaunchResult` without
 *   actually enqueuing". Returning `completed` is the closest
 *   non-side-effecting result the strategy can return without
 *   inventing a new discriminator. T18 will replace the body with
 *   the real enqueue and return `{ kind: 'enqueued', queueJobId }`.
 *   Hosts that depend on the stub in the meantime will observe a
 *   `COMPLETED` `JobExecution` (because the launcher re-resolves the
 *   row from the repository, which is still in `STARTING`/`STARTED`
 *   — this is a known caveat of the stub, and the stub's
 *   `name = 'bullmq-stub'` is the diagnostic signal for it).
 *
 * The strategy does **not** throw on the stub path: T17 explicitly
 * bans "implementing worker execution logic" and the easiest way to
 * honour that is to short-circuit the body. The trade-off is that
 * the stub cannot validate Redis connectivity from inside `launch`;
 * T18's producer-fail-fast test (scenario in
 * `.omo/plans/nest-batch-architecture-enhancement.md` task 18) is
 * the dedicated test for that.
 */
@Injectable()
export class BullMqExecutionStrategy implements IExecutionStrategy {
  /**
   * Strategy name. Distinct from the eventual `'bullmq'` runtime
   * strategy so logs and boundary reports can tell a stub invocation
   * from a real BullMQ invocation during the T17 → T18 cut-over.
   */
  readonly name = 'bullmq-stub';

  private readonly logger = new Logger(BullMqExecutionStrategy.name);

  constructor(
    @Optional()
    @Inject(BULLMQ_MODULE_OPTIONS)
    private readonly options: BullMqModuleOptions | undefined,
  ) {}

  /**
   * Stub `launch()`. The real implementation lives in T18.
   *
   * Returns `{ kind: 'completed', status: 'COMPLETED' }` so the
   * launcher's post-strategy re-resolution path still produces a
   * `JobExecution` shape — this lets the host wire
   * `BullmqBatchModule` end-to-end during T17 even though no
   * actual enqueue has happened.
   *
   * @param _job    Compiled `JobDefinition` (unused by the stub).
   * @param _params Job parameters (unused by the stub).
   * @param _ctx    Pre-resolved execution context from the launcher.
   */
  async launch(
    _job: JobDefinition,
    _params: JobParameters,
    _ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    // T17's scope explicitly bans touching the transport, the
    // queue, the worker, or the repository from the strategy
    // body. The debug log below is the only side effect the stub
    // produces, and it is level-gated by Nest's `Logger` (debug
    // is suppressed in production by default).
    this.logger.debug(
      'BullMqExecutionStrategy.launch() invoked (T17 stub — no enqueue). ' +
        'Real enqueue/worker flow lands in T18.',
    );
    // Returning `completed` here is the closest the stub can get
    // to "no-op without changing the public `JobLauncher.launch`
    // contract". T18 will replace this body with the real
    // enqueue and return `{ kind: 'enqueued', queueJobId }`.
    return { kind: 'completed', status: JobStatus.COMPLETED };
  }
}
