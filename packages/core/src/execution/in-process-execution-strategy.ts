import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';

import { JobRepository, type JobExecution, type JobParameters } from '../core/repository';


import {
  EXECUTION_STRATEGY,
  type ExecutionStrategyContext,
  type IExecutionStrategy,
  type LaunchResult,
} from './execution-strategy';
import { JobExecutor } from './job-executor';

import type { JobDefinition } from '../core/ir';
import { BatchError } from '../core/errors';

/**
 * How `InProcessExecutionStrategy` reacts when a chunk step is
 * configured with `partitions.count > 1` — a state the in-process
 * transport cannot honour (it is single-threaded by design).
 *
 *   - `'throw'` (default): fail the launch with
 *     `InProcessPartitionsNotSupportedError`. The host sees a loud
 *     failure and is forced to either drop the partitions config
 *     or wire up a real transport.
 *   - `'warn'`: log a warning and continue with a single-partition
 *     execution. The host gets a clear signal in the logs but the
 *     step still runs. Useful for local dev / smoke tests where a
 *     full transport wiring is overkill.
 *
 * Pinned by `docs/RELEASE-0.2.0.md §6.3`.
 */
export type InProcessPartitionViolationMode = 'throw' | 'warn';

/**
 * DI token for the `InProcessPartitionViolationMode` option. The
 * host wires it via `NestBatchModule.forRoot({ inProcess: {
 * onPartitionViolation: 'warn' } })` (the module reads it from
 * the options bag and binds the value under this token).
 *
 * The default is `'throw'`, so a host that does not opt in gets
 * the loud failure behaviour. The token is exported so tests can
 * wire a custom mode without going through the module.
 */
export const IN_PROCESS_PARTITION_VIOLATION_MODE =
  Symbol.for('@nest-batch/core/IN_PROCESS_PARTITION_VIOLATION_MODE');

/**
 * Default in-process execution strategy.
 *
 * Wraps the current `JobExecutor.execute` flow behind the
 * polymorphic `IExecutionStrategy` contract so the public
 * `JobLauncher.launch()` API can stay stable while the actual
 * execution target becomes swappable.
 *
 * Lifecycle:
 *   1. The `JobLauncher` pre-creates a `JobExecution` (in `STARTING`)
 *      via the atomic repository helper and passes the resulting
 *      `executionId` in `ctx`.
 *   2. This strategy re-fetches the same `JobExecution` (the in-process
 *      executor needs the full object, not just the id) and hands it to
 *      `JobExecutor.execute`, which drives the steps to a terminal
 *      status (`COMPLETED` / `FAILED`) and persists updates along the
 *      way.
 *   3. The executor returns the final, persisted `JobExecution`; we
 *      translate it into the discriminated `LaunchResult` the contract
 *      requires: `{ kind: 'completed', status }`. The launcher then
 *      re-reads the latest persisted `JobExecution` and hands it to the
 *      caller, keeping the public `Promise<JobExecution>` shape intact.
 *
 * Why `forwardRef` on `JobExecutor`?
 *   `JobLauncher` already uses `forwardRef(() => JobExecutor)` to
 *   keep the dependency graph stable against future refactors. This
 *   strategy is a sibling consumer of the same `JobExecutor`; using
 *   the same `forwardRef` pattern keeps the cyclic-DI safety net
 *   uniform across the launcher and the default strategy.
 */
@Injectable()
export class InProcessExecutionStrategy implements IExecutionStrategy {
  readonly name = 'in-process';

  private readonly logger = new Logger(InProcessExecutionStrategy.name);

  /**
   * The configured partition-violation mode. Tests construct the
   * strategy with a non-default mode; production uses the default
   * ('throw') wired by `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`.
   */
  private readonly onPartitionViolation: InProcessPartitionViolationMode;

  constructor(
    private readonly repository: JobRepository,
    @Inject(forwardRef(() => JobExecutor))
    private readonly jobExecutor: JobExecutor,
    /**
     * Optional injection token for the partition-violation mode.
     * Wired by the host via `NestBatchModule.forRoot({ inProcess: {
     * onPartitionViolation: 'warn' } })`; defaults to `'throw'`
     * when the host does not opt in. The `@Optional()` decorator
     * keeps the constructor backward-compatible with hosts that
     * have not opted in (the test suite for T1-T7 does not bind
     * this token, and the runtime must still work for them).
     */
    @Optional()
    @Inject(IN_PROCESS_PARTITION_VIOLATION_MODE)
    onPartitionViolation: InProcessPartitionViolationMode = 'throw',
  ) {
    this.onPartitionViolation = onPartitionViolation;
  }

  async launch(
    job: JobDefinition,
    _params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    // The in-process strategy is intentionally single-threaded; it
    // cannot fan out across multiple processes or workers. Per
    // `docs/RELEASE-0.2.0.md §6.3`, partition orchestration is the
    // transport's job — when a host configures a chunk step with
    // `partitions.count > 1` against the in-process strategy, we
    // surface the misconfiguration rather than silently single-
    // partitioning. The exact behaviour is controlled by the
    // `onPartitionViolation` constructor option (throw by default,
    // or `warn` to log and proceed with a single partition).
    this.assertPartitionsSupported(job);

    // The launcher pre-created the execution; load the full object
    // the executor needs. If the lookup fails here, the launcher's
    // own state is broken — surface that loudly rather than silently
    // running with `undefined`.
    const execution: JobExecution | null = await this.repository.getJobExecution(ctx.executionId);
    if (execution === null) {
      throw new Error(
        `[InProcessExecutionStrategy] expected JobExecution ${ctx.executionId} to exist`,
      );
    }
    const finished = await this.jobExecutor.execute(execution, job);
    return { kind: 'completed', status: finished.status };
  }

  /**
   * Guard against partitioned chunk steps. Throws by default; logs a
   * warning and continues with a single-partition execution when the
   * host wires up `onPartitionViolation: 'warn'`. The default
   * (throw) is the safer choice because it surfaces the
   * misconfiguration at launch time rather than letting the step
   * run with a silent single-partition semantics.
   */
  private assertPartitionsSupported(job: JobDefinition): void {
    for (const stepId of Object.keys(job.steps)) {
      const step = job.steps[stepId];
      if (step === undefined) continue;
      if (step.kind !== 'chunk') continue;
      const count = step.partitions?.count;
      if (count === undefined || count <= 1) continue;
      if (this.onPartitionViolation === 'warn') {
        this.logger.warn(
          `InProcessExecutionStrategy: step "${stepId}" declares partitions.count=${count} ` +
            'but the in-process strategy cannot fan out. Running as a single partition; ' +
            'configure a transport (BullMQ / Kafka) for true parallel partitioning.',
        );
        continue;
      }
      throw new InProcessPartitionsNotSupportedError(stepId, count);
    }
  }
}

/**
 * Thrown by `InProcessExecutionStrategy` when a chunk step is
 * configured with `partitions.count > 1`. The error is stable —
 * callers that want to switch on it can match `code`. Distinct
 * from `InvalidPartitionsError` (which fires on a structurally
 * invalid config at compile time) because the in-process guard
 * fires on a *valid* config that the chosen transport cannot honour.
 */
export class InProcessPartitionsNotSupportedError extends BatchError {
  readonly code = 'IN_PROCESS_PARTITIONS_NOT_SUPPORTED';
  constructor(stepId: string, count: number) {
    super(
      `InProcessExecutionStrategy does not support partitions.count > 1 (step "${stepId}" declares count=${count}). ` +
        'Use a transport strategy (BullMQ / Kafka) for parallel partitioning.',
      { stepId, count },
    );
  }
}

/**
 * Nest DI provider record that binds `InProcessExecutionStrategy` to
 * the `EXECUTION_STRATEGY` token. Sibling packages (e.g.
 * `@nest-batch/bullmq`) override this binding with their own transport
 * strategy to switch the launcher's execution target without touching
 * the launcher itself.
 *
 * `NestBatchModule.forRoot()` re-exports this provider so apps can add
 * it to their own `providers` array (the strategy needs
 * `JobRepository` and `JobExecutor` to be in the same DI scope, and
 * those are app-owned runtime deps — see the module's docstring for
 * the rationale). Apps that build a `JobLauncher` by hand (no Nest
 * module) can either provide their own `EXECUTION_STRATEGY` binding
 * or rely on the `@Optional()` fallback in `JobLauncher`, which
 * delegates directly to `JobExecutor` when no strategy is injected.
 */
export const IN_PROCESS_EXECUTION_STRATEGY_PROVIDER = {
  provide: EXECUTION_STRATEGY,
  useExisting: InProcessExecutionStrategy,
} as const;
