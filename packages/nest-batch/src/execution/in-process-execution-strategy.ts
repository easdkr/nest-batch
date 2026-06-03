import { Inject, Injectable, forwardRef } from '@nestjs/common';

import { JobRepository, type JobExecution, type JobParameters } from '../core/repository';


import {
  EXECUTION_STRATEGY,
  type ExecutionStrategyContext,
  type IExecutionStrategy,
  type LaunchResult,
} from './execution-strategy';
import { JobExecutor } from './job-executor';

import type { JobDefinition } from '../core/ir';

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

  constructor(
    private readonly repository: JobRepository,
    @Inject(forwardRef(() => JobExecutor))
    private readonly jobExecutor: JobExecutor,
  ) {}

  async launch(
    job: JobDefinition,
    _params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
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
