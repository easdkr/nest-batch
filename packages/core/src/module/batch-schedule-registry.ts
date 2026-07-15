import { Injectable } from '@nestjs/common';

import type { BatchOverlapPolicy } from '../scheduling/batch-scheduled';

/**
 * A single entry recorded in the `BatchScheduleRegistry`.
 *
 * The registry is the contract surface between the
 * discovery-time metadata (stamped by the `@BatchScheduled` decorator
 * and collected by `BatchExplorer`) and runtime scheduler adapters.
 *
 * `inert` is captured at decoration time from
 * `process.env.BATCH_SCHEDULED_DISABLE` and is preserved on the entry
 * verbatim so the runtime scheduler can decide whether to install a
 * real timer. The decorator does NOT inspect the env at runtime
 * scheduling time — the registry carries the resolved value.
 */
export interface BatchScheduleEntry {
  /** The `@Jobable({ id })` value of the host class. */
  readonly jobId: string;
  /** The `@BatchScheduled({ name })` value. Unique per job. */
  readonly scheduleName: string;
  /** The method name on the host class that carries `@BatchScheduled`. */
  readonly methodName: string;
  /** The cron expression supplied to the decorator, verbatim. */
  readonly cron: string;
  /** IANA timezone, as supplied to the decorator. */
  readonly timezone: string;
  /** Overlap policy. `undefined` means the runtime applies its default. */
  readonly overlap?: BatchOverlapPolicy;
  /** Absolute lower bound (optional). */
  readonly startAt?: Date;
  /** Absolute upper bound (optional). */
  readonly endAt?: Date;
  /**
   * Captured at decoration time from
   * `process.env.BATCH_SCHEDULED_DISABLE`. `true` is a hint to the
   * runtime scheduler to skip installing a real timer.
   */
  readonly inert: boolean;
}

/**
 * Internal composite key used by the registry's `Map`. We intentionally
 * avoid the `Symbol`/`string` debate by using a stable string form
 * `${jobId}\u0000${scheduleName}`. There is no risk of collision because
 * `jobId` is unique across the whole registry, and `scheduleName`
 * is required to be unique within a job.
 */
function registryKey(jobId: string, scheduleName: string): string {
  return `${jobId}\u0000${scheduleName}`;
}

/**
 * `BatchScheduleRegistry` — in-memory map of `@BatchScheduled`
 * metadata discovered at bootstrap.
 *
 * Lifecycle:
 *   1. The registry is constructed once at module init (Nest DI
 *      singleton).
 *   2. `BatchExplorer.onModuleInit` walks every provider and calls
 *      `register(entry)` once per discovered `@BatchScheduled` method.
 *   3. A scheduler adapter reads from the registry at app start to
 *      install the actual timers or external schedules.
 *
 * The registry is intentionally metadata-only: it never installs a
 * timer, never reads the env, never resolves the cron expression. It
 * is a pure data structure.
 */
@Injectable()
export class BatchScheduleRegistry {
  private readonly entries = new Map<string, BatchScheduleEntry>();

  /**
   * Number of registered entries. Exposed for diagnostics / health
   * endpoints; the future runtime scheduler also uses it to detect
   * "no schedules" without paying for `getAll().length`.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Register a single `@BatchScheduled` entry.
   *
   * Throws `DuplicateBatchScheduleError` if a `(jobId, scheduleName)`
   * pair is registered twice. This is deterministic: the explorer
   * should never see the same schedule name twice for a given job, so
   * a duplicate is always a programmer / wiring error.
   */
  register(entry: BatchScheduleEntry): void {
    const key = registryKey(entry.jobId, entry.scheduleName);
    if (this.entries.has(key)) {
      throw new DuplicateBatchScheduleError(entry.jobId, entry.scheduleName);
    }
    this.entries.set(key, entry);
  }

  /**
   * Look up a registered entry. Returns `undefined` if no entry exists
   * for the given `(jobId, scheduleName)` pair. The lookup is O(1).
   */
  get(jobId: string, scheduleName: string): BatchScheduleEntry | undefined {
    return this.entries.get(registryKey(jobId, scheduleName));
  }

  /**
   * Boolean variant of `get` — useful for guards and tests where the
   * caller does not need the entry value.
   */
  has(jobId: string, scheduleName: string): boolean {
    return this.entries.has(registryKey(jobId, scheduleName));
  }

  /**
   * Snapshot of every registered entry. Order is insertion order
   * (because the underlying `Map` preserves insertion order); callers
   * that need a stable sort MUST sort the returned array themselves.
   */
  getAll(): BatchScheduleEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Remove every entry. Primarily useful in tests; production code
   * should treat the registry as append-only for the lifetime of the
   * Nest application.
   */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Thrown when the explorer (or any other code path) attempts to
 * register a duplicate `@BatchScheduled` entry for the same
 * `(jobId, scheduleName)` pair.
 *
 * This is a `BatchError` so the existing `core/errors.ts` hierarchy
 * applies. It is exported from the module barrel so adapter code can
 * `instanceof`-check it without reaching into a deep import.
 */
export class DuplicateBatchScheduleError extends Error {
  constructor(jobId: string, scheduleName: string) {
    super(
      `Duplicate @BatchScheduled entry for jobId="${jobId}", name="${scheduleName}". ` +
        `A schedule name can only be registered once per jobId. ` +
        `If you want two schedules for the same job, give them distinct names.`,
    );
    this.name = 'DuplicateBatchScheduleError';
  }
}
