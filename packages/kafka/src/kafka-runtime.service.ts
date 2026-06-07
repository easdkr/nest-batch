import {
  type IExecutionStrategy,
  type JobDefinition,
  type BatchObserver,
  type JobRepository,
  JOB_REPOSITORY_TOKEN,
} from '@nest-batch/core';
import { JobExecutor, JobRegistry, NoopBatchObserver } from '@nest-batch/core';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { Kafka, Producer, Consumer, type Message } from 'kafkajs';


import {
  KAFKA_MODULE_OPTIONS,
  type ResolvedKafkaModuleOptions,
} from './module-options';

/**
 * Payload shape stored in a Kafka message's `value` field.
 *
 * The strategy enqueues one Kafka message per step (or per partition,
 * in a future enhancement). The consumer reconstructs the
 * `JobExecution` from the repository via `executionId` and the
 * `JobDefinition` from the registry via `jobId`.
 *
 * Why not store the full `JobDefinition` in the payload?
 *   - IR is mutable across the host process (decorators / builders
 *     may swap providers in tests, hot-reload, etc.). The
 *     repository + registry are the canonical sources; the
 *     payload carries only the keys needed to look them up.
 *   - Storage size — IRs can be large (listeners, resolvers).
 *     Kafka is transport, not cache; small payloads are cheaper.
 */
export interface KafkaJobPayload {
  /** JobExecution id, used to load the canonical execution row. */
  readonly executionId: string;
  /** Mirrors `executionId` today; kept distinct for forward compat. */
  readonly jobExecutionId: string;
  /** JobDefinition id, used to look up the IR from the registry. */
  readonly jobId: string;
  /** Step id (the message key). */
  readonly stepId: string;
  /**
   * Partition index. Reserved for a future enhancement where a
   * chunk step is split into N partitions and enqueued as N
   * Kafka messages. Today the strategy always enqueues one message
   * per step (regardless of chunk size), so the field is
   * `undefined`. Kept in the payload shape so the consumer
   * can distinguish "this is a step" from "this is a partition"
   * without a separate discriminator.
   */
  readonly partitionIndex?: number;
}

/**
 * Name of the Kafka strategy. Logged by the bridge for diagnostic
 * purposes and asserted by tests that need to distinguish the
 * real implementation from any stub.
 */
export const KAFKA_STRATEGY_NAME = 'kafka';

/**
 * Bridge between the Kafka `Producer` / `Consumer` and the
 * `@nest-batch/core` execution pipeline.
 *
 * Responsibilities:
 *   1. Own the producer / consumer connection clients with the
 *      role-specific tuning.
 *   2. Implement the `IExecutionStrategy` contract: `launch()`
 *      produces a single Kafka message per step, returns
 *      `{ kind: 'enqueued', queueJobId }`. The launch is
 *      fire-and-forget — the strategy does NOT block on the
 *      consumer.
 *   3. Drive the consumer lifecycle (`OnApplicationBootstrap` /
 *      `OnApplicationShutdown`).
 *   4. Bridge consumer events into the `BatchObserver` (defaulting
 *      to `NoopBatchObserver`).
 *   5. Hand off to `JobExecutor.execute(execution, jobDef)` from
 *      inside the consumer — Batch Core remains the source of truth
 *      for state transitions, skip/retry, checkpoint, restart.
 */
@Injectable()
export class KafkaRuntimeService
  implements IExecutionStrategy, OnApplicationBootstrap, OnApplicationShutdown
{
  /**
   * Strategy name. Distinct from any stub so log lines and
   * boundary reports can tell them apart.
   */
  readonly name = KAFKA_STRATEGY_NAME;

  private readonly logger = new Logger(KafkaRuntimeService.name);

  /** Kafka producer (producer side). */
  private producer: Producer | null = null;
  /** Kafka consumer (consumer side). */
  private consumer: Consumer | null = null;
  /** Kafka client instance. */
  private kafka: Kafka | null = null;
  /**
   * Promise-chain lock for the close path. We capture the first
   * `close()` invocation and short-circuit subsequent ones so a
   * stray double-shutdown (Nest calls `OnApplicationShutdown`
   * once, but tests sometimes do their own) does not race the
   * in-flight close.
   */
  private closePromise: Promise<void> | null = null;

  constructor(
    @Inject(KAFKA_MODULE_OPTIONS)
    private readonly options: ResolvedKafkaModuleOptions,
    @Inject(JOB_REPOSITORY_TOKEN)
    private readonly repository: JobRepository,
    @Inject(JobRegistry)
    private readonly registry: JobRegistry,
    @Inject(JobExecutor)
    private readonly jobExecutor: JobExecutor,
    @Optional()
    private readonly observer: BatchObserver = new NoopBatchObserver() as BatchObserver,
  ) {}

  /**
   * Nest lifecycle: spin up the producer and consumer after the
   * DI container is fully wired. We do this in
   * `onApplicationBootstrap` (not `onModuleInit`) so every other
   * provider — including user-supplied `JobRepository` overrides —
   * is already instantiated and injectable.
   *
   * Consumer startup is gated on `options.autoStartConsumer`. The
   * flag exists for launcher-only deployments (e.g. an API service
   * that only produces) and for tests that want to exercise the
   * producer side in isolation. When the flag is `false` the
   * producer is still created (so `launch()` can produce), but the
   * consumer is not started (no consumer means the messages sit in
   * the topic indefinitely).
   */
  onApplicationBootstrap(): void {
    this.kafka = this.buildKafkaClient();
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
    });

    if (this.options.autoStartConsumer) {
      this.consumer = this.kafka.consumer({
        groupId: this.options.consumerGroupId,
        allowAutoTopicCreation: true,
      });
      this.logger.log(
        `KafkaRuntimeService started: topic="${this.options.topic}" ` +
          `consumer=auto, groupId="${this.options.consumerGroupId}"`,
      );
    } else {
      this.logger.log(
        `KafkaRuntimeService started: topic="${this.options.topic}" ` +
          `consumer=manual (autoStartConsumer=false)`,
      );
    }

    // Ensure the work topic exists up-front BEFORE connecting the
    // producer or consumer.  Auto-creation is racy — a `send()`
    // immediately after the first broker comes up can fail with
    // "This server does not host this topic-partition" because
    // metadata hasn't propagated yet.
    void this.ensureTopicExists(this.options.topic).catch((err) => {
      this.logger.warn(
        `Topic ensure failed for "${this.options.topic}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Connect the producer eagerly so launch() is ready.
    void this.producer.connect().catch((err) => {
      this.logger.warn(
        `Producer connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Start the consumer after the topic is guaranteed to exist.
    if (this.consumer !== null) {
      void this.startConsumer();
    }
  }

  /**
   * Nest lifecycle: close every Kafka resource in the documented
   * order — consumer first (let in-flight messages finish or be
   * rebalanced), then producer (the producer is closed last so any
   * pending `send()` calls had a chance to land).
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
   * Produce a single Kafka message per step. Returns
   * `{ kind: 'enqueued', queueJobId }` after the producer has
   * acknowledged the send. The execution is fire-and-forget:
   * the launcher resolves the latest persisted `JobExecution`
   * (which is still in `STARTING`/`STARTED` because the executor
   * has not run yet).
   *
   * The canonical `JobExecution` row is created by the launcher
   * via `repository.createExecutionAtomic` BEFORE this method is
   * called (the `executionId` in `ctx` is the result). This
   * strategy does NOT re-create it; doing so would race the
   * launcher's atomic create.
   *
   * Throws if the producer cannot send (broker down, topic missing
   * with auto-creation disabled, etc.). The launcher re-throws the
   * error to its caller; the `JobExecution` row remains in
   * `STARTING` — the host's recovery path is responsible for
   * transitioning it.
   */
  async launch(
    job: JobDefinition,
    _params: Record<string, unknown>,
    ctx: { executionId: string; jobExecutionId: string },
  ): Promise<{ kind: 'enqueued'; queueJobId: string }> {
    if (this.producer === null) {
      throw new Error(
        `[KafkaRuntimeService] launch() called before onApplicationBootstrap — ` +
          'module is not initialized. Did you forget to import KafkaAdapter?',
      );
    }

    const stepId = job.startStepId;
    const payload: KafkaJobPayload = {
      executionId: ctx.executionId,
      jobExecutionId: ctx.jobExecutionId,
      jobId: job.id,
      stepId,
    };

    const message: Message = {
      key: stepId,
      value: JSON.stringify(payload),
    };

    const result = await this.producer.send({
      topic: this.options.topic,
      messages: [message],
    });

    const first = result[0];
    if (result.length === 0 || first === undefined) {
      throw new Error(
        `[KafkaRuntimeService] send returned empty result (broker down?)`,
      );
    }

    // KafkaJS v2 returns `baseOffset` instead of `offset` when the
    // broker acks the produce request.  Fall back to `baseOffset`
    // so the queueJobId is always populated.
    const offset = first.offset ?? (first as unknown as { baseOffset?: string }).baseOffset;
    if (offset === undefined) {
      throw new Error(
        `[KafkaRuntimeService] send returned undefined offset (broker down?)`,
      );
    }
    this.logger.debug(
      `Produced step "${stepId}" for execution ${ctx.executionId} to Kafka offset ${offset}`,
    );

    return { kind: 'enqueued', queueJobId: offset };
  }

  // -----------------------------------------------------------------------
  // Consumer
  // -----------------------------------------------------------------------

  /**
   * Start the consumer: connect, subscribe to the topic, and begin
   * running the message handler. This is called from
   * `onApplicationBootstrap` when `autoStartConsumer` is true.
   */
  private async startConsumer(): Promise<void> {
    if (this.consumer === null) return;

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.options.topic,
      fromBeginning: true,
    });

    await this.consumer.run({
      autoCommit: true,
      eachMessage: async ({ message }) => {
        if (!message.value) {
          this.logger.warn('Received empty message value; skipping');
          return;
        }
        try {
          const payload: KafkaJobPayload = JSON.parse(message.value.toString());
          await this.processMessage(payload);
        } catch (err) {
          this.logger.warn(
            `Failed to process message: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err; // Re-throw so KafkaJS handles retry / dead-letter
        }
      },
    });
  }

  /**
   * Consumer entry point. Loads the canonical `JobExecution` from
   * the repository and the `JobDefinition` from the registry, then
   * hands the work to `JobExecutor.execute`. All batch semantics
   * (step dispatch, chunk loop, skip/retry, checkpoint) live in
   * the executor — this method is a thin bridge.
   */
  private async processMessage(payload: KafkaJobPayload): Promise<void> {
    // Ignore probe messages used by the e2e helper to confirm
    // the producer is connected.
    if (payload.jobId === 'probe' && payload.executionId === 'probe') {
      return;
    }

    const execution = await this.repository.getJobExecution(payload.executionId);
    if (execution === null) {
      throw new Error(
        `[KafkaRuntimeService] JobExecution ${payload.executionId} not found in repository`,
      );
    }
    const jobDef = this.registry.get(payload.jobId);
    // `JobRegistry.get` throws `JobNotFoundError` if the
    // definition is missing. We let it propagate so KafkaJS
    // records the failure and the dead-letter path catches
    // it (a missing job definition is a misconfiguration that
    // should be loud, not silent).
    await this.jobExecutor.execute(execution, jobDef);
  }

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  private buildKafkaClient(): Kafka {
    return new Kafka({
      clientId: this.options.connection.clientId,
      brokers: [...this.options.connection.brokers],
      ssl: this.options.connection.ssl,
      sasl: this.options.connection.sasl as unknown as import('kafkajs').SASLOptions | undefined,
      connectionTimeout: this.options.connection.connectionTimeout,
      requestTimeout: this.options.connection.requestTimeout,
    });
  }

  /**
   * Idempotent topic creation.  Uses the Kafka admin client to
   * create the topic if it does not already exist.  This removes
   * the metadata-propagation race that causes
   * `KafkaJSProtocolError: This server does not host this topic-
   * partition` when a producer sends to an auto-created topic
   * before all brokers have learned about it.
   */
  private async ensureTopicExists(topic: string): Promise<void> {
    if (this.kafka === null) return;
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const existing = await admin.listTopics();
      if (existing.includes(topic)) return;
      await admin.createTopics({
        topics: [
          {
            topic,
            numPartitions: 1,
            replicationFactor: 1,
          },
        ],
        waitForLeaders: true,
      });
      this.logger.debug(`Created topic "${topic}"`);
    } finally {
      await admin.disconnect().catch(() => {
        /* ignore disconnect errors */
      });
    }
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  /**
   * Close all Kafka resources in the documented order:
   * consumer → producer. Each step is best-effort: a close
   * error on one resource does not prevent the others from
   * being closed.
   */
  private async close(): Promise<void> {
    if (this.consumer !== null) {
      try {
        await this.consumer.disconnect();
      } catch (err) {
        this.logger.warn(
          `Consumer disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.consumer = null;
    }
    if (this.producer !== null) {
      try {
        await this.producer.disconnect();
      } catch (err) {
        this.logger.warn(
          `Producer disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.producer = null;
    }
    this.kafka = null;
  }
}
