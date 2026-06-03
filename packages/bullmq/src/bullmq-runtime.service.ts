import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { Queue, QueueEvents, Worker, type JobsOptions } from 'bullmq';

import {
  type IExecutionStrategy,
  type JobDefinition,
  type JobRepository,
  type BatchObserver,
} from '@nest-batch/core';
import { JobExecutor, JobRegistry, NoopBatchObserver, BATCH_EVENT } from '@nest-batch/core';

import {
  BULLMQ_MODULE_OPTIONS,
  type ResolvedBullMqModuleOptions,
} from './module-options';

/**
 * Payload shape stored in a BullMQ job's `data` field.
 *
 * The strategy enqueues one BullMQ job per step (or per partition,
 * in a future enhancement). The worker reconstructs the
 * `JobExecution` from the repository via `executionId` and the
 * `JobDefinition` from the registry via `jobId`.
 *
 * Why not store the full `JobDefinition` in the payload?
 *   - IR is mutable across the host process (decorators / builders
 *     may swap providers in tests, hot-reload, etc.). The
 *     repository + registry are the canonical sources; the
 *     payload carries only the keys needed to look them up.
 *   - Storage size — IRs can be large (listeners, resolvers).
 *     Redis is transport, not cache; small payloads are cheaper.
 */
export interface BullmqJobPayload {
  /** JobExecution id, used to load the canonical execution row. */
  readonly executionId: string;
  /** Mirrors `executionId` today; kept distinct for forward compat. */
  readonly jobExecutionId: string;
  /** JobDefinition id, used to look up the IR from the registry. */
  readonly jobId: string;
  /** Step id (the `name` field of the BullMQ job). */
  readonly stepId: string;
  /**
   * Partition index. Reserved for a future enhancement where a
   * chunk step is split into N partitions and enqueued as N
   * BullMQ jobs. Today the strategy always enqueues one job
   * per step (regardless of chunk size), so the field is
   * `undefined`. Kept in the payload shape so the worker
   * can distinguish "this is a step" from "this is a partition"
   * without a separate discriminator.
   */
  readonly partitionIndex?: number;
}

/**
 * The single BullMQ queue name used by the strategy + worker +
 * queue-events. We deliberately do not fan out into per-step
 * queues — that would force the host to pre-declare every step
 * name at compile time, which is at odds with the decorator /
 * builder APIs that discover steps at runtime. A single queue
 * keyed by the step's `name` field is the standard BullMQ pattern
 * (the `name` field discriminates the work).
 */
export const BULLMQ_QUEUE_NAME = 'nest-batch:work';

/**
 * Name of the BullMQ strategy. Logged by the bridge for diagnostic
 * purposes and asserted by tests that need to distinguish the
 * real implementation from the T17 stub.
 */
export const BULLMQ_STRATEGY_NAME = 'bullmq';

/**
 * Bridge between the BullMQ `Queue` / `Worker` / `QueueEvents` and
 * the `@nest-batch/core` execution pipeline.
 *
 * Responsibilities (T18 contract):
 *   1. Own the producer / worker connection clients with the
 *      role-specific tuning (fail-fast producer, blocking worker).
 *   2. Implement the `IExecutionStrategy` contract: `launch()`
 *      enqueues a single BullMQ job per step, returns
 *      `{ kind: 'enqueued', queueJobId }`. The launch is
 *      fire-and-forget — the strategy does NOT block on the
 *      worker.
 *   3. Drive the worker lifecycle (`OnApplicationBootstrap` /
 *      `OnApplicationShutdown`).
 *   4. Bridge `QueueEvents` `completed` / `failed` / `stalled`
 *      into the `BatchObserver` (defaulting to `NoopBatchObserver`).
 *   5. Hand off to `JobExecutor.execute(execution, jobDef)` from
 *      inside the worker — Batch Core remains the source of truth
 *      for state transitions, skip/retry, checkpoint, restart.
 *
 * Why a single class (not separate `Queue` / `Worker` providers)?
 *   - The producer and worker share a `connection` record but
 *     carry *different* `ConnectionOptions` (different
 *     `maxRetriesPerRequest`, `enableReadyCheck`, ...). Splitting
 *     them across providers would force the connection-tuning
 *     logic into two places and risk the worker accidentally
 *     inheriting the producer's fail-fast config (or vice versa).
 *   - Lifecycle is a unit: open producer + worker + events
 *     together, close them together in the documented order
 *     (workers first, then events, then queues). Centralising
 *     this in one class makes the close-order a single source
 *     of truth and a single method (`close()`).
 */
@Injectable()
export class BullmqRuntimeService
  implements IExecutionStrategy, OnApplicationBootstrap, OnApplicationShutdown
{
  /**
   * Strategy name. Distinct from the T17 stub's `'bullmq-stub'`
   * so log lines and boundary reports can tell them apart.
   */
  readonly name = BULLMQ_STRATEGY_NAME;

  private readonly logger = new Logger(BullmqRuntimeService.name);

  /** BullMQ queue (producer side). */
  private queue: Queue | null = null;
  /** BullMQ worker (consumer side). */
  private worker: Worker<BullmqJobPayload> | null = null;
  /** BullMQ QueueEvents stream listener. */
  private queueEvents: QueueEvents | null = null;
  /**
   * Promise-chain lock for the close path. We capture the first
   * `close()` invocation and short-circuit subsequent ones so a
   * stray double-shutdown (Nest calls `OnApplicationShutdown`
   * once, but tests sometimes do their own) does not race the
   * in-flight close.
   */
  private closePromise: Promise<void> | null = null;

  constructor(
    @Inject(BULLMQ_MODULE_OPTIONS)
    private readonly options: ResolvedBullMqModuleOptions,
    private readonly repository: JobRepository,
    private readonly registry: JobRegistry,
    private readonly jobExecutor: JobExecutor,
    @Optional()
    private readonly observer: BatchObserver = new NoopBatchObserver() as BatchObserver,
  ) {}

  /**
   * Nest lifecycle: spin up the queue, worker, and queue-events
   * after the DI container is fully wired. We do this in
   * `onApplicationBootstrap` (not `onModuleInit`) so every other
   * provider — including user-supplied `JobRepository` overrides —
   * is already instantiated and injectable.
   *
   * Worker startup is gated on `options.autoStartWorker`. The
   * flag exists for launcher-only deployments (e.g. an API
   * service that only enqueues) and for tests that want to
   * exercise the producer side in isolation. When the flag is
   * `false` the queue is still created (so `launch()` can
   * enqueue), but the worker is not started (no consumer means
   * the jobs sit in the queue indefinitely).
   */
  onApplicationBootstrap(): void {
    this.queue = this.buildQueue();
    this.queueEvents = this.buildQueueEvents();
    this.attachQueueEventsBridge();

    if (this.options.autoStartWorker) {
      this.worker = this.buildWorker();
      this.logger.log(
        `BullmqRuntimeService started: queue="${BULLMQ_QUEUE_NAME}" ` +
          `worker=auto, keyPrefix="${this.options.connection.keyPrefix}"`,
      );
    } else {
      this.logger.log(
        `BullmqRuntimeService started: queue="${BULLMQ_QUEUE_NAME}" ` +
          `worker=manual (autoStartWorker=false)`,
      );
    }
  }

  /**
   * Nest lifecycle: close every BullMQ resource in the documented
   * order — workers first (let in-flight jobs finish or be
   * returned to the queue), then events (no new events can
   * arrive once the worker is closed), then queues (the producer
   * is closed last so any pending `add()` calls had a chance to
   * land).
   *
   * Idempotent: a second call to `onApplicationShutdown` (which
   * can happen in tests) short-circuits to the first close's
   * promise rather than racing.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closePromise = this.close();
    return this.closePromise;
  }

  // -----------------------------------------------------------------------
  // IExecutionStrategy
  // -----------------------------------------------------------------------

  /**
   * Enqueue a single BullMQ job per step. Returns
   * `{ kind: 'enqueued', queueJobId }` after the producer has
   * acknowledged the enqueue. The execution is fire-and-forget:
   * the launcher resolves the latest persisted `JobExecution`
   * (which is still in `STARTING`/`STARTED` because the executor
   * has not run yet).
   *
   * The canonical `JobExecution` row is created by the launcher
   * via `repository.createExecutionAtomic` BEFORE this method is
   * called (the `executionId` in `ctx` is the result). This
   * strategy does NOT re-create it; doing so would race the
   * launcher's atomic create and break the `SELECT ... FOR
   * UPDATE SKIP LOCKED` invariant.
   *
   * Throws if the producer cannot enqueue (Redis down, key
   * collision, etc.). The launcher re-throws the error to its
   * caller; the `JobExecution` row remains in `STARTING` —
   * the host's recovery path (or a manual cleanup) is
   * responsible for transitioning it.
   */
  async launch(
    job: JobDefinition,
    _params: Record<string, unknown>,
    ctx: { executionId: string; jobExecutionId: string },
  ): Promise<{ kind: 'enqueued'; queueJobId: string }> {
    if (this.queue === null) {
      throw new Error(
        `[BullmqRuntimeService] launch() called before onApplicationBootstrap — ` +
          'module is not initialized. Did you forget to import BullmqBatchModule?',
      );
    }
    // One BullMQ job per step. The step's `id` is the BullMQ `name`
    // (so the queue's `KEYS bull:*:<queueName>:<name>` layout
    // groups jobs by step for inspection). T18 explicitly forbids
    // one-job-per-row/per-chunk, so we never iterate steps or
    // partitions here — the executor's chunk loop runs INSIDE the
    // single BullMQ job.
    const stepId = job.startStepId;
    const payload: BullmqJobPayload = {
      executionId: ctx.executionId,
      jobExecutionId: ctx.jobExecutionId,
      jobId: job.id,
      stepId,
    };

    const jobOpts: JobsOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 100, jitter: 0.5 },
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 1000 },
    };

    const enqueued = await this.queue.add(stepId, payload, jobOpts);
    if (enqueued.id === undefined) {
      // BullMQ returns a job with `id` undefined only when the
      // producer cannot reach Redis and the in-memory buffer
      // (which is disabled by `enableOfflineQueue: false`) is
      // not available. Surface this as a hard error so the
      // launcher propagates the failure.
      throw new Error(
        `[BullmqRuntimeService] enqueue returned undefined job id (Redis down?)`,
      );
    }
    this.logger.debug(
      `Enqueued step "${stepId}" for execution ${ctx.executionId} as BullMQ job ${enqueued.id}`,
    );
    return { kind: 'enqueued', queueJobId: String(enqueued.id) };
  }

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  private buildQueue(): Queue {
    return new Queue(BULLMQ_QUEUE_NAME, {
      connection: this.producerConnectionOptions(),
      // `defaultJobOptions` is a defence-in-depth measure. The
      // strategy already passes per-call `JobsOptions` (with
      // the T18 retry / remove policy) so this is the fallback
      // for any code path that calls `queue.add` without
      // explicit options. Today the only caller is the strategy.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 100, jitter: 0.5 },
        removeOnComplete: { count: 100, age: 3600 },
        removeOnFail: { count: 1000 },
      },
      prefix: this.options.connection.keyPrefix,
      // Skip waiting for the producer connection to become ready
      // before returning from `add`. The fail-fast producer
      // options (see `producerConnectionOptions`) make a dead
      // Redis surface as a synchronous error on the first `add`,
      // which is exactly what the "Redis-down" test asserts.
      skipWaitingForReady: true,
    });
  }

  private buildWorker(): Worker<BullmqJobPayload> {
    return new Worker<BullmqJobPayload>(
      BULLMQ_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      {
        connection: this.workerConnectionOptions(),
        prefix: this.options.connection.keyPrefix,
        concurrency: 1,
      },
    );
  }

  private buildQueueEvents(): QueueEvents {
    return new QueueEvents(BULLMQ_QUEUE_NAME, {
      connection: this.workerConnectionOptions(),
      prefix: this.options.connection.keyPrefix,
    });
  }

  /**
   * Wire the `QueueEvents` listeners to the configured
   * `BatchObserver`. Each listener swallows observer errors so
   * a slow / failing observer cannot poison the BullMQ event
   * stream.
   */
  private attachQueueEventsBridge(): void {
    if (this.queueEvents === null) return;
    this.queueEvents.on('completed', ({ jobId }) => {
      void this.bridgeEvent(BATCH_EVENT.JOB_COMPLETED, { queueJobId: jobId, kind: 'completed' });
    });
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      void this.bridgeEvent(BATCH_EVENT.JOB_FAILED, {
        queueJobId: jobId,
        kind: 'failed',
        reason: failedReason,
      });
    });
    this.queueEvents.on('stalled', ({ jobId }) => {
      void this.bridgeEvent(BATCH_EVENT.JOB_FAILED, { queueJobId: jobId, kind: 'stalled' });
    });
  }

  private async bridgeEvent(
    type: (typeof BATCH_EVENT)[keyof typeof BATCH_EVENT],
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.observer.onEvent({
        type,
        timestamp: new Date(),
        jobExecutionId: String(data['queueJobId'] ?? '<unknown>'),
        data,
      });
    } catch (err) {
      this.logger.warn(
        `BatchObserver threw on event ${type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Worker processor — delegated to JobExecutor
  // -----------------------------------------------------------------------

  /**
   * Worker entry point. Loads the canonical `JobExecution` from
   * the repository and the `JobDefinition` from the registry, then
   * hands the work to `JobExecutor.execute`. All batch semantics
   * (step dispatch, chunk loop, skip/retry, checkpoint) live in
   * the executor — this method is a thin bridge.
   */
  private async processJob(payload: BullmqJobPayload): Promise<void> {
    const execution = await this.repository.getJobExecution(payload.executionId);
    if (execution === null) {
      // The DB row is gone. The launcher pre-created it via
      // `createExecutionAtomic`; if it's missing now, the host
      // either deleted it or restored a DB without the row.
      // Surface as a BullMQ-level failure so the technical
      // retry / dead-letter path handles it.
      throw new Error(
        `[BullmqRuntimeService] JobExecution ${payload.executionId} not found in repository`,
      );
    }
    const jobDef = this.registry.get(payload.jobId);
    // `JobRegistry.get` throws `JobNotFoundError` if the
    // definition is missing. We let it propagate so BullMQ
    // records the failure and the dead-letter queue catches
    // it (a missing job definition is a misconfiguration that
    // should be loud, not silent).
    await this.jobExecutor.execute(execution, jobDef);
  }

  // -----------------------------------------------------------------------
  // Connection options
  // -----------------------------------------------------------------------

  /**
   * Producer-side connection tuning. The two flags below are
   * the contract the T18 "Redis-down" test depends on:
   *
   *   - `enableOfflineQueue: false`  — a `Queue.add()` against a
   *     dead Redis MUST throw synchronously rather than buffer
   *     the command. Without this, BullMQ keeps the command in
   *     memory and `add()` returns success, breaking the
   *     "fail fast" guarantee.
   *   - `maxRetriesPerRequest: 1`    — keep the first `add`
   *     fast; subsequent reconnects are handled by ioredis
   *     itself (we do not want BullMQ to block on retries
   *     during the launcher call).
   *
   * BullMQ specifically warns against `maxRetriesPerRequest: null`
   * on the producer, because the producer does not use blocking
   * commands. We use `1` for the same reason.
   */
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

  /**
   * Worker-side connection tuning. Two flags that BullMQ
   * *requires* for blocking workers (per the BullMQ docs):
   *
   *   - `maxRetriesPerRequest: null` — the worker's
   *     `BLPOP` / `BRPOPLPUSH` / `XREADGROUP` commands MUST NOT
   *     retry per request. A stalled worker surfaces as a
   *     stall, not a connection error.
   *   - `enableReadyCheck: false`   — the worker should not
   *     refuse to start when Redis is in the middle of a
   *     failover; ioredis reconnects on its own.
   */
  private workerConnectionOptions(): Record<string, unknown> {
    return {
      host: this.options.connection.host,
      port: this.options.connection.port,
      password: this.options.connection.password,
      username: this.options.connection.username,
      db: this.options.connection.db,
      ...(this.options.connection.tls ? { tls: true } : {}),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  /**
   * Close all BullMQ resources in the documented order:
   * worker → events → queue. Each step is best-effort: a close
   * error on one resource does not prevent the others from
   * being closed.
   */
  private async close(): Promise<void> {
    if (this.worker !== null) {
      try {
        await this.worker.close();
      } catch (err) {
        this.logger.warn(
          `Worker close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.worker = null;
    }
    if (this.queueEvents !== null) {
      try {
        await this.queueEvents.close();
      } catch (err) {
        this.logger.warn(
          `QueueEvents close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.queueEvents = null;
    }
    if (this.queue !== null) {
      try {
        await this.queue.close();
      } catch (err) {
        this.logger.warn(
          `Queue close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.queue = null;
    }
  }
}
