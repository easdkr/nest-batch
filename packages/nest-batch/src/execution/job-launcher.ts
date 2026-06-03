import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JobRegistry } from '../registry/job-registry';
import { JobRepository, type JobParameters, type JobExecution } from '../core/repository';
import type { JobDefinition } from '../core/ir';
import { JobNotFoundError, JobExecutionAlreadyRunningError } from '../core/errors';
import { canonicalJobKey } from './job-key';
import { JobExecutor } from './job-executor';

/**
 * JobLauncher — public entry point for starting a new JobExecution.
 *
 * Flow:
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
 *   4. Delegate to `JobExecutor.execute` to actually run the steps.
 *      The lock is released when the createExecutionAtomic transaction
 *      commits; the executor itself runs outside the lock (it can be
 *      long-running).
 *
 * `allowDuplicateInstances: true` bypasses step 2's dedup by appending a
 * fresh UUID nonce to the canonical key on every call, forcing a new
 * `JobInstance` each time. (Restart-aware re-runs of FAILED executions
 * will land in Task 37.)
 */
@Injectable()
export class JobLauncher {
  constructor(
    private readonly registry: JobRegistry,
    private readonly repository: JobRepository,
    @Inject(forwardRef(() => JobExecutor))
    private readonly jobExecutor: JobExecutor,
  ) {}

  /**
   * Launch a new job execution. Returns the final `JobExecution` after it
   * has finished (status = COMPLETED | FAILED).
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

    return this.jobExecutor.execute(execution, jobDef);
  }

  /**
   * Resume an existing `JobExecution` (used by the restart path, Task 37).
   * For this MVP it just delegates to the executor — the launcher does
   * not yet gate on restartable / concurrency / FAILED-prev-exists rules.
   */
  async run(execution: JobExecution, jobDef: JobDefinition): Promise<JobExecution> {
    return this.jobExecutor.execute(execution, jobDef);
  }
}
