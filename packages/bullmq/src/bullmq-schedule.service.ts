import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';

import { BATCH_SCHEDULE_REGISTRY, BatchScheduleRegistry, type BatchScheduleEntry } from '@nest-batch/core';

import { BULLMQ_MODULE_OPTIONS, type ResolvedBullMqModuleOptions } from './module-options';

/**
 * The single BullMQ queue name used by the schedule service. We
 * intentionally use a DIFFERENT queue from the runtime service's
 * `BULLMQ_QUEUE_NAME` so cron-triggered jobs and ad-hoc
 * `launch()`-triggered jobs are inspectable in isolation (and so
 * the schedule-removal path on shutdown can tear them down
 * without touching the runtime work queue).
 *
 * BullMQ 5 rejects queue names that contain a colon (`:`) because
 * it is the path separator in the key layout. We use a hyphen
 * (`-`) instead, matching the existing `BULLMQ_QUEUE_NAME`
 * convention (`'nest-batch-work'`).
 */
export const BULLMQ_SCHEDULE_QUEUE_NAME = 'nest-batch-schedule';

/**
 * `BullmqScheduleService` — the runtime scheduler for
 * `@BatchScheduled` entries.
 *
 * Lifecycle:
 *   1. `OnApplicationBootstrap` walks the `BatchScheduleRegistry`
 *      and, for every entry with `inert: false`, registers a
 *      BullMQ repeating job via `queue.upsertJobScheduler(...)`.
 *      Entries with `inert: true` are logged and skipped — that
 *      is the only place the inert flag is consulted.
 *   2. BullMQ's `upsertJobScheduler` internally fires the
 *      schedule at the configured cron time. Each fire enqueues a
 *      job into the schedule queue (named after the schedule
 *      entry's method). A separate `Worker` (the one owned by
 *      `BullmqRuntimeService` if `autoStartWorker` is `true`)
 *      processes the jobs.
 *   3. `OnApplicationShutdown` removes every installed scheduler
 *      (via `queue.removeJobScheduler`) and closes the queue.
 *      Removal is best-effort: a partial failure logs a warning
 *      but does not block the rest of the shutdown.
 *
 * Why a dedicated service (not a method on `BullmqRuntimeService`)?
 *   - The runtime service is `IExecutionStrategy`-facing; it
 *     knows about `JobExecution`, the in-process launch contract,
 *     and the worker bridge. Mixing scheduler concerns in would
 *     bloat its surface and couple two lifecycles that happen to
 *     share a Redis client but are otherwise independent.
 *   - The scheduler does NOT need a `Worker`; the runtime service
 *     does. A separate service can run with `autoStartWorker:
 *     false` cleanly (a launcher-only deployment that still wants
 *     cron schedules to fire).
 *   - The schedule service owns its own `Queue` (the schedule
 *     queue) so cron jobs are not interleaved with manually-launched
 *     jobs. They share the same `keyPrefix` so the host's Redis
 *     namespace policy still applies.
 */
@Injectable()
export class BullmqScheduleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BullmqScheduleService.name);

  /** BullMQ queue for the scheduler (producer side only). */
  private scheduleQueue: Queue | null = null;

  /**
   * Every schedule key installed during `onApplicationBootstrap`.
   * Tracked so the shutdown path can `removeJobScheduler` for
   * each one deterministically. A `Set` keeps the test assertions
   * order-independent.
   */
  private readonly installedKeys = new Set<string>();

  /** Promise-chain lock for the close path. Mirrors the runtime service. */
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly scheduleRegistry: BatchScheduleRegistry,
    @Inject(BULLMQ_MODULE_OPTIONS)
    private readonly options: ResolvedBullMqModuleOptions,
  ) {}

  /**
   * Walk the registry and install every non-inert entry as a
   * BullMQ repeating job. Runs AFTER the `BatchBootstrapper` has
   * populated the registry (both hooks are on
   * `OnApplicationBootstrap`, but Nest calls them in
   * provider-registration order; the bootstrapper is registered
   * before this service by `BullmqBatchModule.forRoot()`).
   *
   * Each entry is wrapped in a per-entry `try` so a single bad
   * schedule does not abort the rest of the installation. Bad
   * schedules are logged and skipped — the runtime keeps running
   * for the valid ones.
   */
  onApplicationBootstrap(): void {
    this.scheduleQueue = this.buildScheduleQueue();
    const entries = this.scheduleRegistry.getAll();
    for (const entry of entries) {
      try {
        this.installSchedule(entry);
      } catch (err) {
        this.logger.warn(
          `Failed to install schedule for "${entry.jobId}::${entry.methodName}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(
      `BullmqScheduleService started: queue="${BULLMQ_SCHEDULE_QUEUE_NAME}" ` +
        `schedules=${this.installedKeys.size}/${entries.length} ` +
        `(skipped=${entries.length - this.installedKeys.size} inert)`,
    );
  }

  /**
   * Tear down every installed scheduler and close the schedule
   * queue. Idempotent: a second `onApplicationShutdown` short-
   * circuits to the first close's promise.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closePromise = this.close();
    return this.closePromise;
  }

  /**
   * Installed scheduler keys, in insertion order. Exposed for
   * tests and diagnostics. Read-only: callers MUST NOT mutate
   * the returned array.
   */
  installedSchedulerKeys(): readonly string[] {
    return Array.from(this.installedKeys);
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Install a single entry as a BullMQ repeating job. Skips
   * inert entries (the runtime honours the inert flag by NOT
   * calling `upsertJobScheduler` for them). Throws on
   * installation failure so the caller can log + continue.
   */
  private installSchedule(entry: BatchScheduleEntry): void {
    if (entry.inert) {
      this.logger.log(
        `Skipping inert schedule: ${entry.jobId}::${entry.methodName} ` +
          `(cron="${entry.cron}", tz="${entry.timezone}")`,
      );
      return;
    }
    if (this.scheduleQueue === null) {
      // Defensive: should never happen because `onApplicationBootstrap`
      // builds the queue before iterating entries, but a future
      // refactor that calls `installSchedule` from elsewhere
      // should fail loudly.
      throw new Error('[BullmqScheduleService] scheduleQueue is null');
    }
    const schedulerKey = `${entry.jobId}::${entry.methodName}`;
    const template: {
      name: string;
      data: Record<string, unknown>;
      opts: JobsOptions;
    } = {
      name: entry.methodName,
      data: { jobId: entry.jobId, methodName: entry.methodName },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 100, jitter: 0.5 },
        removeOnComplete: { count: 100, age: 3600 },
        removeOnFail: { count: 1000 },
      },
    };
    void this.scheduleQueue.upsertJobScheduler(
      schedulerKey,
      { pattern: entry.cron, tz: entry.timezone },
      template,
    );
    this.installedKeys.add(schedulerKey);
    this.logger.log(
      `Installed schedule: ${schedulerKey} (cron="${entry.cron}", tz="${entry.timezone}")`,
    );
  }

  // -------------------------------------------------------------------------
  // Queue construction
  // -------------------------------------------------------------------------

  /**
   * Build the producer-side BullMQ queue for the scheduler. The
   * connection tuning mirrors the runtime service's producer
   * options: fail-fast on Redis-down (`enableOfflineQueue:
   * false`) and a tight per-request retry budget
   * (`maxRetriesPerRequest: 1`).
   */
  private buildScheduleQueue(): Queue {
    return new Queue(BULLMQ_SCHEDULE_QUEUE_NAME, {
      connection: this.producerConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 100, jitter: 0.5 },
        removeOnComplete: { count: 100, age: 3600 },
        removeOnFail: { count: 1000 },
      },
      prefix: this.options.connection.keyPrefix,
      skipWaitingForReady: true,
      // Mirrors the runtime service: skip the constructor-time
      // version probe so the queue does not throw on a Redis
      // client that is not yet ready.
      skipVersionCheck: true,
    });
  }

  private producerConnectionOptions(): Record<string, unknown> {
    return {
      host: this.options.connection.host,
      port: this.options.connection.port,
      password: this.options.connection.password,
      username: this.options.connection.username,
      db: this.options.connection.db,
      ...(this.options.connection.tls ? { tls: true } : {}),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    };
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  /**
   * Close the schedule queue. `removeJobScheduler` is called
   * first for every installed key so the next run of the host
   * app does not inherit leftover schedulers. Each removal is
   * best-effort: a failure on one key does not prevent the
   * others from being removed.
   */
  private async close(): Promise<void> {
    if (this.scheduleQueue !== null) {
      for (const key of this.installedKeys) {
        try {
          await this.scheduleQueue.removeJobScheduler(key);
        } catch (err) {
          this.logger.warn(
            `removeJobScheduler("${key}") failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      try {
        await this.scheduleQueue.close();
      } catch (err) {
        this.logger.warn(
          `Schedule queue close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.scheduleQueue = null;
    }
  }
}
