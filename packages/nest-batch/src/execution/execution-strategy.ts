import type { JobDefinition } from '../core/ir';
import type { JobParameters } from '../core/repository';
import type { JobStatus } from '../core/status';

/**
 * NestJS DI token for the polymorphic execution strategy.
 *
 * `JobLauncher` is a thin facade that delegates the actual execution
 * to whatever `IExecutionStrategy` is bound to this token. The default
 * in-process strategy wraps the current `JobExecutor` flow; sibling
 * packages (e.g. `@nest-batch/bullmq`) override this provider with a
 * transport strategy that enqueues step / partition work.
 *
 * Injecting by token (not by class) lets the host application swap
 * the strategy at module composition time without subclassing
 * `JobLauncher`.
 *
 * Defined as a `symbol` to avoid accidental string collisions with
 * other DI tokens in the host application. The symbol is registered
 * in the global symbol registry under a stable, package-scoped key
 * (`@nest-batch/core/EXECUTION_STRATEGY`) so it is unique across the
 * process.
 */
export const EXECUTION_STRATEGY: symbol = Symbol.for(
  '@nest-batch/core/EXECUTION_STRATEGY',
);

/**
 * Context handed to the strategy alongside the job definition and
 * parameters. The launcher pre-resolves the canonical `jobKey` and
 * the atomic instance + execution lock; the resulting identifiers
 * are passed in `ctx` so the strategy can correlate them (e.g. a
 * BullMQ job's `jobId` may be set to `executionId`).
 *
 * Field semantics:
 *   - `executionId` — fresh execution id assigned by
 *     `JobRepository.createExecutionAtomic`. The strategy uses this
 *     to load the latest persisted `JobExecution` from the
 *     repository (in the in-process case) or to stamp a queue job.
 *   - `jobExecutionId` — same value as `executionId` today (kept as
 *     a distinct field so future transport strategies that need to
 *     split "execution" from "job execution" — e.g. multi-step
 *     partition fan-out — have a stable slot to fill). Both fields
 *     are present so the contract is forward-compatible.
 */
export interface ExecutionStrategyContext {
  /**
   * Fresh execution id assigned by the repository's atomic create.
   *
   * The strategy uses this to load the latest persisted
   * `JobExecution` from the repository (in the in-process case) or
   * to stamp a queue job (in transport strategies).
   */
  readonly executionId: string;
  /**
   * Job execution id. Today this mirrors `executionId`; the field
   * is kept distinct so transport strategies can stamp the
   * `JobExecution.id` on a queue payload without losing the
   * underlying `executionId` correlation key, and so the contract
   * matches the public terminology used by callers.
   */
  readonly jobExecutionId: string;
}

/**
 * Discriminated result returned by `IExecutionStrategy.launch`.
 *
 * - `kind: 'completed'` — the strategy ran the job to a terminal
 *   state in-process (or synchronously simulated it). The launcher
 *   resolves the persisted `JobExecution` (whose `status` matches
 *   the `status` field) and returns it to the caller. Public API
 *   shape is unchanged: `Promise<JobExecution>`.
 *
 * - `kind: 'enqueued'` — the strategy handed the job off to a
 *   transport (e.g. a BullMQ queue). The launcher still resolves
 *   the latest persisted `JobExecution` (which remains in
 *   `STARTING` / `STARTED` because the executor did not run) and
 *   returns it. The `queueJobId` is for the strategy's own
 *   bookkeeping; the public `JobLauncher.launch` API does not
 *   surface it (signature must remain stable per the plan).
 */
export type LaunchResult =
  | { readonly kind: 'completed'; readonly status: JobStatus }
  | { readonly kind: 'enqueued'; readonly queueJobId: string };

/**
 * Polymorphic execution contract for `JobLauncher`.
 *
 * Implementations decide *how* a job runs:
 *   - in-process (default, wraps `JobExecutor`),
 *   - transport-based (BullMQ, Sidekiq, custom queue, ...).
 *
 * The launcher owns everything *outside* the strategy boundary:
 *   - registry lookup + canonical `jobKey` derivation,
 *   - atomic get-or-create instance + concurrency lock,
 *   - translating the strategy's `LaunchResult` back to the public
 *     `JobExecution` shape.
 *
 * The strategy owns everything *inside* the boundary:
 *   - invoking the steps in-process,
 *   - or handing the work to a transport and returning an enqueue
 *     result.
 *
 * `name` is purely for diagnostics — log lines and boundary
 * reports. Two strategies with identical behavior but different
 * `name` values are treated as distinct by the host.
 */
export interface IExecutionStrategy {
  readonly name: string;
  launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult>;
}
