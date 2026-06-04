import { Injectable, Inject, Optional, forwardRef, Logger } from '@nestjs/common';
import type { JobDefinition, ListenerDefinition } from '../core/ir';
import { RefKind, type ListenerRef } from '../core/ir';
import { JobRepository, type JobParameters, type JobExecution } from '../core/repository';
import { TransactionManager } from '../core/transaction';
import { StepStatus, JobStatus, FlowExecutionStatus } from '../core/status';
import { JobNotRestartableError } from '../core/errors';
import { TaskletStepExecutor, type StepExecutionResult } from './tasklet-step-executor';
import { ChunkStepExecutor, type ChunkExecutionResult } from './chunk-step-executor';
import {
  ListenerInvoker,
  type ResolverMap,
  type ListenerResolver,
} from './listener-invoker';
import { FlowEvaluator } from '../flow/flow-evaluator';
import {
  BATCH_EVENT,
  NoopBatchObserver,
  type BatchEvent,
  type BatchObserver,
} from '../observability';

/**
 * Result type that covers both tasklet and chunk step outcomes.
 * Structurally compatible with `StepExecutionPatch` so the executor
 * can forward it directly to `updateStepExecution`.
 *
 * The only field chunk has but tasklet doesn't is `commitCount`; for
 * tasklet results it stays `undefined` and `updateStepExecution`
 * happily ignores undefined fields (merge semantics, see repository).
 */
type StepResult = StepExecutionResult | ChunkExecutionResult;

/**
 * JobExecutor — drives a single JobExecution to completion.
 *
 * Flow (per ORACLE verdict 3c):
 *   1. Mark execution as STARTED.
 *   2. `before:job:*` listeners.
 *   3. Loop:
 *      a. Look up the current step (jobDef.steps[currentStepId]). If the
 *         step is missing, mark the job FAILED with exit code
 *         `NO_SUCH_STEP` and break.
 *      b. Create a StepExecution, run it (tasklet or chunk), and persist
 *         the result via `updateStepExecution`. During the run, the
 *         step's own `after-step:*` listeners fire (see
 *         `TaskletStepExecutor.execute` step 4 / `ChunkStepExecutor`).
 *         Those listeners run BEFORE we evaluate transitions so they get
 *         a chance to mutate the result (e.g. flip COMPLETED → FAILED)
 *         and the resulting flow routing sees the override.
 *      c. Map the (possibly overridden) step status to a
 *         `FlowExecutionStatus` and ask the `FlowEvaluator` for the next
 *         step. `null` means END.
 *      d. If the step FAILED and the evaluator returned `null`
 *         (no recovery transition matches), short-circuit the job to
 *         FAILED — we must not continue running subsequent steps
 *         declared in the graph, because none are reachable.
 *   4. `after:job:*` listeners (with the final status).
 *
 * Out of scope (future tasks):
 *   - Concurrency control (Task 38).
 *   - `on-error:job:*` listener invocation when the executor itself
 *     throws (the catch block can be wired to it in a follow-up).
 */
@Injectable()
export class JobExecutor {
  private readonly logger = new Logger(JobExecutor.name);

  constructor(
    private readonly repository: JobRepository,
    @Inject(forwardRef(() => TransactionManager))
    private readonly transactionManager: TransactionManager,
    private readonly taskletExecutor: TaskletStepExecutor,
    private readonly chunkExecutor: ChunkStepExecutor,
    private readonly listenerInvoker: ListenerInvoker,
    private readonly flowEvaluator: FlowEvaluator,
    @Optional()
    private readonly observer: BatchObserver = new NoopBatchObserver(),
  ) {}

  /**
   * Execute a JobExecution against its `JobDefinition`. Returns the
   * final, persisted `JobExecution` (status = COMPLETED | FAILED).
   *
   * Restart behavior (per Metis verdict 3b — restartable opt-in, per
   * ORACLE 3b — default-on for persisted repositories):
   *   - If `execution.status` is `FAILED` on entry, this is a restart
   *     attempt. We require `jobDef.restartable === true`; otherwise we
   *     throw `JobNotRestartableError` and leave the execution alone.
   *   - For each chunk step, we look up the latest FAILED StepExecution
   *     for that step in this job execution. If one exists, we read its
   *     ExecutionContext's `lastChunkIndex` checkpoint and pass it to the
   *     `ChunkStepExecutor` as `resumeFromChunkIndex`, which then skips
   *     chunks ≤ that index. Tasklet steps always re-run from scratch
   *     (they have no chunk-level resume granularity in this MVP).
   */
  async execute(execution: JobExecution, jobDef: JobDefinition): Promise<JobExecution> {
    // Capture the pre-execute status. For a fresh launch, the launcher
    // created the execution with status STARTING; for a restart, the
    // caller (JobLauncher.run) is handing us a previously-FAILED
    // execution. The check below gates the restart path on that
    // distinction.
    const isRestart = execution.status === JobStatus.FAILED;
    if (isRestart && !jobDef.restartable) {
      throw new JobNotRestartableError(jobDef.id);
    }

    await this.repository.updateJobExecution(execution.id, {
      status: JobStatus.STARTED,
      startTime: new Date(),
    });

    await this.emit({
      type: BATCH_EVENT.JOB_STARTED,
      timestamp: new Date(),
      jobExecutionId: execution.id,
      data: { jobName: jobDef.id },
    });

    // Build the full resolver map once. The same map powers both the
    // job-level `invokeBefore` / `invokeAfter` calls below and the
    // step-level resolvers handed to the TaskletStepExecutor (derived
    // by `buildLegacyStepResolvers` into the legacy key shape). Building
    // it once per execution avoids re-walking the IR on every step.
    const jobResolvers = this.buildResolverMap(jobDef);
    const stepResolvers = this.buildLegacyStepResolvers(jobResolvers);

    await this.listenerInvoker.invokeBefore(jobResolvers, 'job', {
      jobExecutionId: execution.id,
      stepExecutionId: '<job>',
    });

    // Cache the step order once. `Object.keys` returns insertion order
    // for string keys (per ES2015+), so this is the canonical
    // declaration order — used for the linear fallback below.
    const stepOrder = Object.keys(jobDef.steps);

    let currentStepId: string | null = jobDef.startStepId;
    let finalStatus: JobStatus = JobStatus.COMPLETED;
    let currentStepExecutionId: string | null = null;

    try {
      while (currentStepId !== null) {
        const step = jobDef.steps[currentStepId];
        if (!step) {
          await this.repository.updateJobExecution(execution.id, {
            status: JobStatus.FAILED,
            endTime: new Date(),
            exitCode: 'NO_SUCH_STEP',
            exitMessage: `Step "${currentStepId}" not found`,
          });
          finalStatus = JobStatus.FAILED;
          break;
        }

        // Restart path: if this is a restart and the current step is a
        // chunk step, locate the latest FAILED step execution for the
        // same step name and load its `lastChunkIndex` checkpoint. That
        // value is passed to the chunk executor as `resumeFromChunkIndex`.
        // For tasklet steps (and chunk steps with no prior failure) we
        // leave `resumeFromChunkIndex` undefined — the chunk executor
        // treats undefined as "start from the beginning".
        //
        // Look this up BEFORE createStepExecution so the just-created
        // STARTING step isn't returned as the "latest" entry.
        let resumeFromChunkIndex: number | undefined;
        if (isRestart && step.kind === 'chunk') {
          const priorFailed = await this.repository.findLatestStepExecution(execution.id, step.id);
          if (priorFailed && priorFailed.status === StepStatus.FAILED) {
            resumeFromChunkIndex = await this.getLastCheckpoint(priorFailed.id);
          }
        }

        const stepExecution = await this.repository.createStepExecution(execution.id, step.id);
        currentStepExecutionId = stepExecution.id;

        await this.emit({
          type: BATCH_EVENT.STEP_STARTED,
          timestamp: new Date(),
          jobExecutionId: execution.id,
          stepExecutionId: stepExecution.id,
          data: { stepId: step.id, kind: step.kind },
        });

        let result: StepResult;
        try {
          if (step.kind === 'tasklet') {
            result = await this.taskletExecutor.execute(step, {
              jobExecutionId: execution.id,
              jobRepository: this.repository,
              transactionManager: this.transactionManager,
              listenerInvoker: this.listenerInvoker,
              listenerResolvers: stepResolvers,
            });
          } else {
            result = await this.chunkExecutor.execute(step, {
              jobExecutionId: execution.id,
              stepExecutionId: stepExecution.id,
              jobRepository: this.repository,
              transactionManager: this.transactionManager,
              listenerInvoker: this.listenerInvoker,
              jobExecutionId2: execution.id,
              resolvers: new Map(),
              ...(resumeFromChunkIndex !== undefined ? { resumeFromChunkIndex } : {}),
            });
          }
        } catch (stepErr) {
          // The executor itself threw (e.g. resolveReader threw in a
          // chunk step before the executor's own try-catch could catch
          // it). Persist the step as FAILED with the error message and
          // re-raise so the outer handler marks the job FAILED.
          await this.repository.updateStepExecution(stepExecution.id, {
            status: StepStatus.FAILED,
            exitCode: 'FAILED',
            exitMessage: stepErr instanceof Error ? stepErr.message : String(stepErr),
            endTime: new Date(),
          });
          currentStepExecutionId = null;
          throw stepErr;
        }
        currentStepExecutionId = null;

        await this.repository.updateStepExecution(stepExecution.id, {
          status: result.status,
          ...(result.readCount !== undefined ? { readCount: result.readCount } : {}),
          ...(result.writeCount !== undefined ? { writeCount: result.writeCount } : {}),
          ...(result.skipCount !== undefined ? { skipCount: result.skipCount } : {}),
          ...('commitCount' in result && result.commitCount !== undefined
            ? { commitCount: result.commitCount }
            : {}),
          exitCode: result.exitCode,
          exitMessage: result.exitMessage,
          endTime: new Date(),
        });

        await this.emit({
          type:
            result.status === StepStatus.COMPLETED
              ? BATCH_EVENT.STEP_COMPLETED
              : result.status === StepStatus.FAILED
                ? BATCH_EVENT.STEP_FAILED
                : BATCH_EVENT.STEP_COMPLETED,
          timestamp: new Date(),
          jobExecutionId: execution.id,
          stepExecutionId: stepExecution.id,
          data: {
            stepId: step.id,
            status: result.status,
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          },
        });

        // Map StepStatus -> FlowExecutionStatus. Anything other than
        // COMPLETED/FAILED collapses to UNKNOWN → evaluator returns
        // null → flow ends.
        const flowStatus: FlowExecutionStatus =
          result.status === StepStatus.COMPLETED
            ? FlowExecutionStatus.COMPLETED
            : result.status === StepStatus.FAILED
              ? FlowExecutionStatus.FAILED
              : FlowExecutionStatus.UNKNOWN;

        const evaluatorResult = await this.flowEvaluator.evaluate(
          jobDef.transitions,
          currentStepId,
          flowStatus,
        );

        // Distinguish "no transition declared" (linear fallback) from
        // "transition declared with toStepId: null" (explicit END).
        // FlowEvaluator returns null for both, so we inspect the
        // transition list directly.
        const hasMatchingTransition = jobDef.transitions.some(
          (t) => t.fromStepId === currentStepId && t.onStatus === flowStatus,
        );

        let nextStepId: string | null;
        if (hasMatchingTransition) {
          // Explicit transition: respect its target, including null
          // (END). Do not fall through to linear order.
          nextStepId = evaluatorResult;
        } else if (result.status === StepStatus.FAILED) {
          // FAILED with no matching transition → short-circuit. The
          // graph declares no path forward, so the job is FAILED — we
          // must not invent a "next" step.
          await this.repository.updateJobExecution(execution.id, {
            status: JobStatus.FAILED,
            endTime: new Date(),
            exitCode: result.exitCode,
            exitMessage: result.exitMessage,
          });
          finalStatus = JobStatus.FAILED;
          break;
        } else {
          // COMPLETED with no transition → linear fallback to the next
          // step in declaration order. If we're already on the last
          // step, the job ends.
          const currentIdx = stepOrder.indexOf(currentStepId);
          const nextIdx = currentIdx + 1;
          nextStepId = nextIdx < stepOrder.length ? stepOrder[nextIdx]! : null;
        }

        currentStepId = nextStepId;
      }

      if (finalStatus === JobStatus.COMPLETED) {
        await this.repository.updateJobExecution(execution.id, {
          status: JobStatus.COMPLETED,
          endTime: new Date(),
          exitCode: 'COMPLETED',
        });
      }
    } catch (err) {
      // Defensive: leave the job FAILED rather than crash the host.
      await this.repository.updateJobExecution(execution.id, {
        status: JobStatus.FAILED,
        endTime: new Date(),
        exitMessage: err instanceof Error ? err.message : String(err),
      });
      finalStatus = JobStatus.FAILED;
    }

    // `after:job:*` listeners run once the job is in a terminal state.
    // They receive the final status as the second positional argument
    // (the `args` slot in the current API; the legacy builder path used
    // the same shape). The resolver map is the same one built above;
    // we re-use it to avoid a second IR walk.
    await this.listenerInvoker.invokeAfter(
      jobResolvers,
      'job',
      { jobExecutionId: execution.id, stepExecutionId: '<job>' },
      [{ status: finalStatus }],
    );

    await this.emit({
      type:
        finalStatus === JobStatus.COMPLETED ? BATCH_EVENT.JOB_COMPLETED : BATCH_EVENT.JOB_FAILED,
      timestamp: new Date(),
      jobExecutionId: execution.id,
      data: { status: finalStatus },
    });

    return (await this.repository.getJobExecution(execution.id))!;
  }

  /**
   * Build a listener resolver map for the given job. Walks every
   * `ListenerDefinition` in `jobDef.listeners` (job-level + step-level +
   * chunk-level + item-level + skip-level) and resolves each ref into a
   * callable `ListenerEntry` keyed by `${phase}:${kind}:${name}`.
   *
   * The returned map is consumed by `ListenerInvoker.invokeBefore /
   * invokeAfter / invokeOnError / invokeOnSkip*` (Task 20 API). The legacy
   * step-level methods (`invokeBeforeStep` etc.) consume a derived
   * legacy-shaped map produced by `buildLegacyStepResolvers` — that
   * conversion happens at the call site, not here, so this method stays
   * the single source of truth for the new shape.
   *
   * Ref resolution rules:
   *   - `RefKind.BuilderLambda`  → use `ref.fn` directly (the compiler
   *                                pre-binds decorator-discovered methods
   *                                and the builder API ships bare fns).
   *   - `RefKind.Method`         → requires the Jobable instance. Until
   *                                a `ModuleRef` is wired (Task 9+), this
   *                                branch logs a warning and is skipped.
   *   - `RefKind.ProviderToken`  → resolved in Task 9 against a
   *                                pre-built provider map. Skipped here
   *                                with a warning.
   */
  private buildResolverMap(jobDef: JobDefinition): ResolverMap {
    const resolvers: ResolverMap = new Map();
    let lambdaCounter = 0;

    for (const def of jobDef.listeners) {
      const fn = this.resolveListenerRef(def);
      if (fn === null) continue;

      const name = this.resolveListenerName(def.ref, lambdaCounter);
      if (def.ref.kind === RefKind.BuilderLambda) lambdaCounter += 1;

      const key = `${def.phase}:${def.kind}:${name}`;
      resolvers.set(key, {
        fn,
        ...(def.nonCritical !== undefined ? { nonCritical: def.nonCritical } : {}),
      });
    }

    return resolvers;
  }

  /**
   * Resolve a single `ListenerDefinition` to its callable function, or
   * `null` if the ref kind is not yet supported. See `buildResolverMap`
   * for the per-kind resolution contract.
   */
  private resolveListenerRef(def: ListenerDefinition): ((...args: any[]) => any) | null {
    const ref = def.ref;
    switch (ref.kind) {
      case RefKind.BuilderLambda:
        return ref.fn ?? null;
      case RefKind.Method:
        this.logger.warn(
          `JobExecutor: Method-ref listener (classToken=${ref.classToken ?? '<unknown>'}, ` +
            `methodName=${ref.methodName ?? '<unknown>'}) requires a Jobable instance; ` +
            'this resolution path lands in a follow-up task. Listener skipped.',
        );
        return null;
      case RefKind.ProviderToken:
        this.logger.warn(
          `JobExecutor: ProviderToken-ref listener (token=${ref.token ?? '<empty>'}) ` +
            'is resolved in Task 9. Listener skipped.',
        );
        return null;
      default: {
        const _exhaustive: never = ref.kind;
        void _exhaustive;
        return null;
      }
    }
  }

  /**
   * Derive the `name` segment of the resolver key. Method refs carry a
   * `classToken` + `methodName` pair that uniquely identifies the bound
   * method; BuilderLambda refs do not carry a name (the compiler drops
   * the method name when it pre-binds), so we mint a `lambda-N` name
   * from a per-job counter to guarantee uniqueness.
   */
  private resolveListenerName(ref: ListenerRef, lambdaCounter: number): string {
    if (ref.kind === RefKind.Method) {
      return `${ref.classToken ?? '<unknown>'}.${ref.methodName ?? '<unknown>'}`;
    }
    return `lambda-${lambdaCounter}`;
  }

  /**
   * Derive a legacy `Map<string, ListenerResolver>` from a new
   * `ResolverMap`, containing only the step-level entries with their
   * keys translated from `${phase}:step:${name}` back to the legacy
   * `${phase}-step:${name}` shape. The `nonCritical` flag is dropped
   * (legacy `ListenerResolver` is a bare function with no metadata).
   *
   * This is the bridge the `TaskletStepExecutor` (which still consumes
   * the legacy shape) needs until it migrates to the new API. Kept as
   * a private helper so the conversion logic is in one place.
   */
  private buildLegacyStepResolvers(resolvers: ResolverMap): Map<string, ListenerResolver> {
    const legacy: Map<string, ListenerResolver> = new Map();
    for (const [key, entry] of resolvers.entries()) {
      if (key.startsWith('before:step:')) {
        legacy.set(`before-step:${key.slice('before:step:'.length)}`, entry.fn as ListenerResolver);
      } else if (key.startsWith('after:step:')) {
        legacy.set(`after-step:${key.slice('after:step:'.length)}`, entry.fn as ListenerResolver);
      } else if (key.startsWith('on-error:step:')) {
        legacy.set(`on-step-error:${key.slice('on-error:step:'.length)}`, entry.fn as ListenerResolver);
      }
    }
    return legacy;
  }

  /**
   * Read the `lastChunkIndex` checkpoint from the step-scoped
   * ExecutionContext for `stepExecutionId`. Returns `undefined` when the
   * step has no recorded checkpoint (e.g., the prior run failed on the
   * very first chunk and never got a chance to write one). The chunk
   * executor treats `undefined` as "no resume; start from the beginning".
   */
  private async getLastCheckpoint(stepExecutionId: string): Promise<number | undefined> {
    const ctx = await this.repository.getExecutionContext({ stepExecutionId });
    if (ctx.data === null || typeof ctx.data !== 'object' || Array.isArray(ctx.data)) {
      return undefined;
    }
    const value = (ctx.data as { lastChunkIndex?: unknown }).lastChunkIndex;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /**
   * Dispatch a BatchEvent to the configured observer. Errors thrown by
   * the observer are swallowed: a failing logger/queue must not crash
   * the executor (the job's persisted state is the source of truth).
   */
  private async emit(event: BatchEvent): Promise<void> {
    try {
      await this.observer.onEvent(event);
    } catch {
      // intentional: observer failures are best-effort and must not
      // affect the executor's own state transitions.
    }
  }
}

// Re-export common types for convenience so callers that import
// `JobExecutor` don't need a second import for `StepExecutionResult` etc.
export type { StepExecutionResult } from './tasklet-step-executor';
export type { ChunkExecutionResult } from './chunk-step-executor';
export type { JobParameters, JobExecution };
