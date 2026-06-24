import {
  BATCH_SCHEDULE_REGISTRY,
  BatchScheduleRegistry,
  type BatchScheduleEntry,
} from '@nest-batch/core';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Kafka, Producer, type Message } from 'kafkajs';

import { KAFKA_MODULE_OPTIONS, type ResolvedKafkaModuleOptions } from './module-options';

/**
 * The single Kafka topic name used by the schedule service. We
 * intentionally use a DIFFERENT topic from the runtime service's
 * default topic so cron-triggered jobs and ad-hoc
 * `launch()`-triggered jobs are inspectable in isolation (and so
 * the schedule-removal path on shutdown can tear them down
 * without touching the runtime work topic).
 */
export const KAFKA_SCHEDULE_TOPIC = 'nest-batch-schedule';

/**
 * `KafkaSchedule` — the runtime scheduler for
 * `@BatchScheduled` entries.
 *
 * Lifecycle:
 *   1. `OnApplicationBootstrap` walks the `BatchScheduleRegistry`
 *      and, for every entry with `inert: false`, registers a
 *      `setInterval`-based cron trigger that produces a message
 *      to the schedule topic at the configured cron time.
 *   2. Each fire produces a message into the schedule topic.
 *      A separate `Consumer` (the one owned by
 *      `KafkaRuntime` if `autoStartConsumer` is `true`)
 *      processes the messages.
 *   3. `OnApplicationShutdown` clears every installed interval
 *      and disconnects the schedule producer.
 *
 * Why a dedicated service (not a method on `KafkaRuntime`)?
 *   - The runtime service is `IExecutionStrategy`-facing; it
 *     knows about `JobExecution`, the in-process launch contract,
 *     and the consumer bridge. Mixing scheduler concerns in would
 *     bloat its surface and couple two lifecycles that happen to
 *     share a Kafka client but are otherwise independent.
 *   - The scheduler does NOT need a consumer; the runtime service
 *     does. A separate service can run with `autoStartConsumer:
 *     false` cleanly (a launcher-only deployment that still wants
 *     cron schedules to fire).
 *   - The schedule service owns its own `Producer` (the schedule
 *     producer) so cron jobs are not interleaved with manually-
 *     launched jobs. They share the same Kafka cluster.
 */
@Injectable()
export class KafkaSchedule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaSchedule.name);

  /** Kafka producer for the scheduler (producer side only). */
  private scheduleProducer: Producer | null = null;
  /** Kafka client instance. */
  private kafka: Kafka | null = null;

  /**
   * Every interval id installed during `onApplicationBootstrap`.
   * Tracked so the shutdown path can `clearInterval` for
   * each one deterministically.
   */
  private readonly intervalIds = new Set<NodeJS.Timeout>();

  /** Promise-chain lock for the close path. Mirrors the runtime service. */
  private closePromise: Promise<void> | null = null;

  constructor(
    @Inject(BATCH_SCHEDULE_REGISTRY)
    private readonly scheduleRegistry: BatchScheduleRegistry,
    @Inject(KAFKA_MODULE_OPTIONS)
    private readonly options: ResolvedKafkaModuleOptions,
  ) {}

  /**
   * Walk the registry and install every non-inert entry as a
   * cron-based interval. Runs AFTER the `BatchBootstrapper` has
   * populated the registry.
   *
   * Each entry is wrapped in a per-entry `try` so a single bad
   * schedule does not abort the rest of the installation. Bad
   * schedules are logged and skipped — the runtime keeps running
   * for the valid ones.
   */
  onApplicationBootstrap(): void {
    this.kafka = this.buildKafkaClient();
    this.scheduleProducer = this.kafka.producer({
      allowAutoTopicCreation: true,
    });

    // Connect the producer eagerly.
    void this.scheduleProducer.connect().catch((err) => {
      this.logger.warn(
        `Schedule producer connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const entries = this.scheduleRegistry.getAll();
    for (const entry of entries) {
      try {
        this.installSchedule(entry);
      } catch (err) {
        this.logger.warn(
          `Failed to install schedule for "${entry.jobId}::${entry.scheduleName}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(
      `KafkaSchedule started: topic="${KAFKA_SCHEDULE_TOPIC}" ` +
        `schedules=${this.intervalIds.size}/${entries.length} ` +
        `(skipped=${entries.length - this.intervalIds.size} inert)`,
    );
  }

  /**
   * Tear down every installed interval and disconnect the schedule
   * producer. Idempotent: a second `onApplicationShutdown` short-
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
   * Installed interval ids, in insertion order. Exposed for
   * tests and diagnostics. Read-only: callers MUST NOT mutate
   * the returned array.
   */
  installedSchedulerKeys(): readonly string[] {
    return Array.from(this.intervalIds).map((id) => String(id));
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Install a single entry as a cron-based interval. Skips
   * inert entries. Throws on installation failure so the caller
   * can log + continue.
   *
   * For the MVP we use a simple `setInterval` with a 1-minute
   * resolution. A future enhancement can swap this for a proper
   * cron parser (e.g. `node-cron`) for sub-minute precision.
   */
  private installSchedule(entry: BatchScheduleEntry): void {
    if (entry.inert) {
      this.logger.log(
        `Skipping inert schedule: ${entry.jobId}::${entry.scheduleName} ` +
          `(cron="${entry.cron}", tz="${entry.timezone}")`,
      );
      return;
    }
    if (this.scheduleProducer === null) {
      throw new Error('[KafkaSchedule] scheduleProducer is null');
    }

    // Parse the cron expression into a millisecond interval.
    // For the MVP we support simple `*/N * * * *` patterns.
    const intervalMs = this.parseCronToIntervalMs(entry.cron);
    if (intervalMs === null) {
      this.logger.warn(
        `Unsupported cron pattern "${entry.cron}" for ${entry.jobId}::${entry.scheduleName}; skipping`,
      );
      return;
    }

    const schedulerKey = `${entry.jobId}::${entry.scheduleName}`;
    const intervalId = setInterval(() => {
      void this.fireSchedule(entry, schedulerKey);
    }, intervalMs);

    this.intervalIds.add(intervalId);
    this.logger.log(
      `Installed schedule: ${schedulerKey} (cron="${entry.cron}", intervalMs=${intervalMs})`,
    );
  }

  /**
   * Fire a single schedule: produce a message to the schedule topic.
   */
  private async fireSchedule(entry: BatchScheduleEntry, schedulerKey: string): Promise<void> {
    if (this.scheduleProducer === null) return;

    const message: Message = {
      key: schedulerKey,
      value: JSON.stringify({
        jobId: entry.jobId,
        scheduleName: entry.scheduleName,
        methodName: entry.methodName,
        timestamp: Date.now(),
      }),
    };

    try {
      await this.scheduleProducer.send({
        topic: KAFKA_SCHEDULE_TOPIC,
        messages: [message],
      });
      this.logger.debug(`Fired schedule: ${schedulerKey}`);
    } catch (err) {
      this.logger.warn(
        `Failed to fire schedule ${schedulerKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Parse a cron expression into a millisecond interval.
   * Supports only star-slash-N minute patterns for the MVP.
   *
   * Returns null for unsupported patterns.
   */
  private parseCronToIntervalMs(cron: string): number | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const minutePart = parts[0]!;
    const hourPart = parts[1]!;
    const domPart = parts[2]!;
    const monthPart = parts[3]!;
    const dowPart = parts[4]!;

    // Support `*/N` minute intervals with all other fields as `*`.
    const starFields = [hourPart, domPart, monthPart, dowPart];
    if (!starFields.every((f) => f === '*')) return null;

    const stepMatch = minutePart.match(/^\*\/(\d+)$/);
    if (!stepMatch) return null;

    const step = Number(stepMatch[1]);
    if (!Number.isInteger(step) || step <= 0 || step > 60) return null;

    return step * 60 * 1000;
  }

  // -------------------------------------------------------------------------
  // Kafka client construction
  // -------------------------------------------------------------------------

  private buildKafkaClient(): Kafka {
    return new Kafka({
      clientId: `${this.options.connection.clientId}-schedule`,
      brokers: [...this.options.connection.brokers],
      ssl: this.options.connection.ssl,
      sasl: this.options.connection.sasl as unknown as import('kafkajs').SASLOptions | undefined,
      connectionTimeout: this.options.connection.connectionTimeout,
      requestTimeout: this.options.connection.requestTimeout,
    });
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  /**
   * Close the schedule producer and clear all intervals.
   */
  private async close(): Promise<void> {
    for (const id of this.intervalIds) {
      clearInterval(id);
    }
    this.intervalIds.clear();

    if (this.scheduleProducer !== null) {
      try {
        await this.scheduleProducer.disconnect();
      } catch (err) {
        this.logger.warn(
          `Schedule producer disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.scheduleProducer = null;
    }
    this.kafka = null;
  }
}
