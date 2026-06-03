import { randomUUID } from 'crypto';

import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';

import { JobNotFoundError, JobExecutionAlreadyRunningError } from '../core/errors';
import { JobRepository, type JobParameters, type JobExecution } from '../core/repository';
import { JobRegistry } from '../registry/job-registry';

import {
  EXECUTION_STRATEGY,
  type IExecutionStrategy,
} from './execution-strategy';
import { JobExecutor } from './job-executor';
import { canonicalJobKey } from './job-key';

import type { JobDefinition } from '../core/ir';



/**
 * JobLauncher — public entry point for starting a new JobExecution.
 *
 * Flow (pre-strategy, kept unchanged for backwards compat):
 *   1. Look up the `JobDefinition` from the registry. Missing → `JobNotFoundError`.
 *   2. Canonicalize `params` into a stable `jobKey` hash. Object key order,
 *      `null/undefined` omission, `Date → ISO` are all normalized so that
 *      semantically-identical params yield the same key.
 *   3. `createExecutionAtomic(jobId, jobKey, params)` — idempotent
 *      instance get-or-create + `SELECT ... FOR UPDATE SKIP LOCKED` to
 *      serialize concurrent launches + running-execution check + insert,
 *      all in a single transaction. Throws
 *      `JobExecutionAlreadyRunningError` if another launch is in flight
 *      or an execution is already STARTING/STARTED for the same instance.
 *   4. Delegate to the injected `IExecutionStrategy` (default:
 *      `InProcessExecutionStrategy`, which wraps `JobExecutor.execute`).
 *      The lock is released when the createExecutionAtomic transaction
 *      commits; the executor itself runs outside the lock (it can be
 *      long-running).
 *
 * `allowDuplicateInstances: true` bypasses step 2's dedup by appending a
 * fresh UUID nonce to the canonical key on every call, forcing a new
 * `JobInstance` each time.
 *
 * Polymorphic strategy (Task 11):
 *   The launcher is a thin facade — it owns the registry lookup, the
 *   canonical `jobKey` derivation, the atomic instance + concurrency
 *   lock, and the post-strategy `JobExecution` re-resolution. The
 *   actual *how* of running the job (in-process vs. transport) lives
 *   behind the `EXECUTION_STRATEGY` token. Sibling packages (e.g.
 *   `@nest-batch/bullmq`) override the token with a transport
 *   strategy that enqueues work; the launcher never learns about the
 *   transport.
 *
 *   When no strategy is bound (e.g. direct manual construction in
 *   unit tests), the launcher falls back to the original direct
 *   `JobExecutor.execute` path. This keeps the legacy
 *   `tests/execution/job-launcher.test.ts` working without changes.
 */
@Injectable()
export class JobLauncher {
  constructor(
    private readonly registry: JobRegistry,
    private readonly repository: JobRepository,
    @Inject(forwardRef(() => JobExecutor))
    private readonly jobExecutor: JobExecutor,
    @Optional()
    @Inject(EXECUTION_STRATEGY)
    private readonly strategy?: IExecutionStrategy,
  ) {}

  /**
   * Launch a new job execution. Returns the final `JobExecution` after it
   * has finished (status = COMPLETED | FAILED) — or, for transport
   * strategies that return `{ kind: 'enqueued' }`, the latest persisted
   * `JobExecution` (still in `STARTING` / `STARTED`, since the executor
   * has not run on the launcher process).
   *
   * Throws `JobNotFoundError` if `jobId` is not registered.
   * Throws `JobExecutionAlreadyRunningError` if a previous launch of the
   * same `jobName + jobKey` is still in flight.
   */
  async launch(jobId: string, params: JobParameters = {}): Promise<JobExecution> {
    const jobDef = this.registry.get(jobId); // throws JobNotFoundError on miss
    const canonical = canonicalJobKey(params);
    const jobKey = jobDef.allowDuplicateInstances ? `${canonical}::${randomUUID()}` : canonical;

    // Atomic get-or-create + lock + check + insert. The repository's
    // implementation uses INSERT ... ON CONFLICT DO NOTHING +
    // FOR UPDATE SKIP LOCKED to serialize concurrent launches.
    const execution = await this.repository.createExecutionAtomic(jobId, jobKey, params);

    // No strategy bound → fall back to the legacy direct-execute path.
    // This branch preserves `tests/execution/job-launcher.test.ts` (which
    // wires the launcher by hand, no Nest module) and any other
    // direct-construction consumer.
    if (this.strategy === undefined) {
      return this.jobExecutor.execute(execution, jobDef);
    }

    // The strategy's `LaunchResult` is intentionally discarded: the
    // public `JobLauncher.launch` contract always returns a
    // `JobExecution` (re-resolved from the repository below), and
    // `queueJobId` is for the strategy's own bookkeeping only.
    await this.strategy.launch(jobDef, params, {
      executionId: execution.id,
      jobExecutionId: execution.id,
    });

    // For both `completed` and `enqueued` the public `JobLauncher.launch`
    // contract returns a `JobExecution`. Re-resolve the latest persisted
    // row so the caller sees the executor's writes (status, endTime,
    // exitCode) without us hand-merging patches here. If the lookup
    // somehow returns null (e.g. a custom repository that drops rows),
    // fall back to the execution the launcher pre-created.
    const latest = await this.repository.getJobExecution(execution.id);
    return latest ?? execution;
  }

  /**
   * Resume an existing `JobExecution` (used by the restart path).
   * For this MVP it just delegates to the executor — the launcher does
   * not yet gate on restartable / concurrency / FAILED-prev-exists rules.
   *
   * Note: `run` bypasses the strategy on purpose. Restart is a
   * recovery path on the in-process execution model; transport
   * strategies that need their own resume semantics can override
   * this method on a subclass or via a future token.
   */
  async run(execution: JobExecution, jobDef: JobDefinition): Promise<JobExecution> {
    return this.jobExecutor.execute(execution, jobDef);
  }
}
