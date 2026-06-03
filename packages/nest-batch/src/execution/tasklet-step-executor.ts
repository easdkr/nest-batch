import { Injectable } from '@nestjs/common';
import type { TaskletStepDefinition, ListenerDefinition } from '../core/ir';
import { RefKind } from '../core/ir';
import type { Tasklet, TaskletContext } from '../core/item';
import type {
  JobRepository,
  ExecutionContext,
  StepExecution,
  ExecutionScope,
} from '../core/repository';
import type { TransactionManager } from '../core/transaction';
import { StepStatus, JobStatus } from '../core/status';
import { ListenerInvoker, type ListenerResolver } from './listener-invoker';
import { resolveProviderToken, type ProviderResolvers } from './ref-resolver';

/**
 * Bundled dependencies + state for a single `TaskletStepExecutor.execute()` call.
 * The caller (JobExecutor, Task 20) owns lifecycle and persistence.
 */
export interface TaskletExecutionContext {
  jobExecutionId: string;
  jobRepository: JobRepository;
  transactionManager: TransactionManager;
  listenerInvoker: ListenerInvoker;
  /** Map from ListenerRef key (`phase:name`) to actual function. */
  listenerResolvers: Map<string, ListenerResolver>;
  /** Optional map of provider-token id → already-resolved provider instance
   *  for `RefKind.ProviderToken` tasklet refs. */
  providerResolvers?: ProviderResolvers;
}

/**
 * Result of a single tasklet step. Mirrors the subset of `StepExecutionPatch`
 * that the executor can fill in BEFORE the JobExecutor persists it.
 *
 * - `status`        — `COMPLETED` if the tasklet returned, `FAILED` if it threw
 * - `exitCode`      — short string label (`COMPLETED` / `FAILED`)
 * - `exitMessage`   — tasklet's return value (on success) or error message (on failure)
 * - `readCount`/`writeCount`/`skipCount` — always 0 for tasklets (no chunk loop)
 */
export interface StepExecutionResult {
  status: StepStatus;
  exitCode: string;
  exitMessage: string;
  readCount: number;
  writeCount: number;
  skipCount: number;
}

/**
 * TaskletStepExecutor — runs a single tasklet step.
 *
 * Orchestration contract (in order):
 *   1. `before-step:*` listeners (always run; failures bubble up)
 *   2. `transactionManager.withTransaction(tasklet.execute, ctx)`
 *   3a. On success → result `{ status: COMPLETED, exitCode: 'COMPLETED', exitMessage: <return> }`
 *   3b. On error  → `on-step-error:*` listeners → result `{ status: FAILED, exitCode: 'FAILED', exitMessage: <err> }`
 *   4. `after-step:*` listeners (always run, receives the result)
 *
 * Persistence of the StepExecution is the caller's responsibility —
 * this executor returns a `StepExecutionResult` and the JobExecutor (Task 20)
 * applies it via `jobRepository.updateStepExecution()`.
 *
 * Read/write counts are always 0 for tasklets; the chunk executor (Task 18)
 * produces non-zero counts.
 */
@Injectable()
export class TaskletStepExecutor {
  /**
   * Execute a tasklet step. Returns the step execution result.
   * The caller (JobExecutor, Task 20) handles persistence of the StepExecution.
   */
  async execute(
    step: TaskletStepDefinition,
    context: TaskletExecutionContext,
  ): Promise<StepExecutionResult> {
    // Build the TaskletContext the tasklet will see.
    //
    // `stepExecutionId` is a placeholder here — the JobExecutor knows the real
    // ID (it created the StepExecution) and will patch this object before the
    // tasklet uses it. The placeholder keeps the contract explicit.
    //
    // `getExecutionContext` / `saveExecutionContext` are also stubbed here;
    // they become real once the JobExecutor wires the stepExecutionId in.
    // (For Wave 3 tests we do not exercise these methods.)
    const taskletCtx: TaskletContext = {
      jobExecutionId: context.jobExecutionId,
      stepExecutionId: '<pending>',
      getExecutionContext: async () => ({ data: null, version: 0 }),
      saveExecutionContext: async (_ctx: ExecutionContext) => {
        // wired by JobExecutor (Task 20) once stepExecutionId is known
      },
    };

    // 1. before-step listeners
    await context.listenerInvoker.invokeBeforeStep(context.listenerResolvers, {
      jobExecutionId: context.jobExecutionId,
      stepExecutionId: taskletCtx.stepExecutionId,
    });

    let result: StepExecutionResult;
    try {
      // 2. withTransaction wrap
      const taskletInstance = this.resolveTasklet(step.tasklet, context);
      const txResult = await context.transactionManager.withTransaction(async (_txCtx) => {
        return taskletInstance.execute(taskletCtx);
      });
      result = {
        status: StepStatus.COMPLETED,
        exitCode: 'COMPLETED',
        exitMessage: txResult === undefined ? '' : String(txResult),
        readCount: 0,
        writeCount: 0,
        skipCount: 0,
      };
    } catch (err) {
      // 3. on-step-error listeners (best-effort: rethrow their failures too)
      await context.listenerInvoker.invokeOnErrorStep(
        context.listenerResolvers,
        { jobExecutionId: context.jobExecutionId, stepExecutionId: taskletCtx.stepExecutionId },
        err,
      );
      result = {
        status: StepStatus.FAILED,
        exitCode: 'FAILED',
        exitMessage: err instanceof Error ? err.message : String(err),
        readCount: 0,
        writeCount: 0,
        skipCount: 0,
      };
    }

    // 4. after-step listeners (always run, even on failure).
    // Pass the LIVE `result` (not a snapshot) so an `after-step`
    // listener can mutate `result.status` and steer the flow into a
    // different branch — transition evaluation runs AFTER this call.
    await context.listenerInvoker.invokeAfterStep(
      context.listenerResolvers,
      { jobExecutionId: context.jobExecutionId, stepExecutionId: taskletCtx.stepExecutionId },
      result,
    );

    return result;
  }

  /**
   * Resolve a `TaskletRef` to a `Tasklet` instance.
   *
   * Supported kinds:
   *   - `builder-lambda`  — `taskletRef.fn` is the bound tasklet function.
   *   - `provider-token`  — looked up in `context.providerResolvers` against
   *                         `taskletRef.token`. The bound instance must
   *                         expose an `execute(ctx)` method.
   *
   * Method refs are pre-resolved by the caller and wrapped in a
   * `builder-lambda` ref before reaching this executor.
   */
  private resolveTasklet(
    taskletRef: { kind: string; token?: string; fn?: ListenerResolver; classToken?: string; methodName?: string },
    context: TaskletExecutionContext,
  ): Tasklet {
    if (taskletRef.kind === RefKind.BuilderLambda && taskletRef.fn) {
      const result = taskletRef.fn();
      if (typeof result === 'function') {
        return { execute: result as Tasklet['execute'] };
      }
      if (result !== null && typeof result === 'object' && typeof (result as Tasklet).execute === 'function') {
        return result as Tasklet;
      }
      return { execute: taskletRef.fn as Tasklet['execute'] };
    }
    if (taskletRef.kind === RefKind.ProviderToken) {
      return resolveProviderToken<Tasklet>('tasklet', taskletRef, context.providerResolvers);
    }
    throw new Error(`Tasklet resolution not supported for ref kind: ${taskletRef.kind}`);
  }
}

// Re-exports for convenience — callers may import types from the executor module.
export type { Tasklet, TaskletContext } from '../core/item';
export type { StepExecution, ExecutionScope };
export { StepStatus, JobStatus };
