import {
  type IExecutionStrategy,
  type JobDefinition,
  type BatchObserver,
  type JobRepository,
  JOB_REPOSITORY_TOKEN,
  enforcePartitionIndex,
  validatePartitions,
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
 * The strategy enqueues one Kafka message per step, OR — when the
 * start step declares `partitions.count >= 2` (T9, T-AC-3 second
 * half) — one Kafka message per partition. The consumer
 * reconstructs the `JobExecution` from the repository via
 * `executionId` and the `JobDefinition` from the registry via
 * `jobId`. The `partitionIndex` field (when present) is the
 * application-level partition discriminator — distinct from the
 * broker's topic-partition, which is a transport-level concept
 * (see `docs/RELEASE-0.2.0.md §6`).
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
   * Partition index (T9 — T-AC-3 second half). When the start step
   * declares `partitions.count >= 2`, the strategy produces N Kafka
   * messages (one per partition) and stamps each with a distinct
   * `partitionIndex` in `[0, N)`. The consumer reads this field back
   * from the payload (NOT the broker's topic-partition — that is a
   * transport-level concept that must not be conflated with the
   * application-level partition discriminator; see
   * `docs/RELEASE-0.2.0.md §6`).
   *
   * `undefined` means "non-partitioned" (the 0.1.0 path, preserved
   * when `partitions` is absent or `count === 1`). Kept in the
   * payload shape so the consumer can distinguish "this is a step"
   * from "this is a partition" without a separate discriminator.
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
 *      produces a single Kafka message per step (or, for chunk
 *      steps with `partitions.count >= 2` — T9 / T-AC-3 second
 *      half — one message per partition, each carrying a
 *      distinct `partitionIndex`). Returns
 *      `{ kind: 'enqueued', queueJobId }`. The launch is
 *      fire-and-forget — the strategy does NOT block on the
 *      consumer.
 *   3. Drive the consumer lifecycle (`OnApplicationBootstrap` /
 *      `OnApplicationShutdown`).
 *   4. Bridge consumer events into the `BatchObserver` (defaulting
 *      to `NoopBatchObserver`).
 *   5. Hand off to `JobExecutor.execute(execution, jobDef, partition?)`
 *      from inside the consumer — Batch Core remains the source of
 *      truth for state transitions, skip/retry, checkpoint, restart.
 *      When the message payload carries a `partitionIndex`, the
 *      consumer validates it and forwards the pair to the executor
 *      so the chunk loop is bounded to the partition's range.
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
   * Produce the work to Kafka and return the message offset. Returns
   * `{ kind: 'enqueued', queueJobId }` after the producer has
   * acknowledged the send. The execution is fire-and-forget:
   * the launcher resolves the latest persisted `JobExecution`
   * (which is still in `STARTING`/`STARTED` because the executor
   * has not run yet).
   *
   * **Partition orchestration (T9 — T-AC-3 second half)**: when the
   * start step declares `partitions.count >= 2`, the strategy
   * produces N Kafka messages (one per partition) to the configured
   * topic, each carrying a distinct `partitionIndex` in `[0, N)`.
   * The default behaviour (`partitions` absent or `count === 1`)
   * produces a single message per step, matching the 0.1.0
   * contract. The `validatePartitions` call surfaces a
   * misconfiguration (e.g. `count <= 0`) at the launcher's boundary
   * so the host's caller sees the failure before the consumer is
   * ever asked to process the message.
   *
   * The `queueJobId` returned is the offset of the LAST produced
   * message (in the partitioned case) or the single message's
   * offset (in the non-partitioned case). The launcher does not
   * surface the queue job id; the field is for the strategy's
   * own bookkeeping.
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
    const startStep = job.steps[stepId];
    // T9 (partition orchestration): when the start step declares
    // `partitions.count >= 2`, the strategy produces N Kafka messages
    // (one per partition, each carrying a distinct `partitionIndex`).
    // Otherwise (default, `count === 1`, or absent) it preserves the
    // 0.1.0 "one message per step" behaviour. The `partitions` slot
    // only exists on chunk steps, so non-chunk start steps
    // short-circuit to the non-partitioned path.
    const partitions = startStep?.kind === 'chunk' ? startStep.partitions : undefined;
    validatePartitions(partitions);
    const partitionCount = partitions?.count ?? 1;
    const partitionOrdinals: number[] =
      partitionCount >= 2 ? Array.from({ length: partitionCount }, (_, i) => i) : [-1];

    let lastQueueJobId: string | null = null;
    for (const partitionIndex of partitionOrdinals) {
      const isPartition = partitionIndex >= 0;
      const payload: KafkaJobPayload = {
        executionId: ctx.executionId,
        jobExecutionId: ctx.jobExecutionId,
        jobId: job.id,
        stepId,
        ...(isPartition ? { partitionIndex } : {}),
      };
      // The Kafka message key mirrors the step id for the
      // non-partitioned case (so all messages for the same step
      // land on the same broker partition, preserving any
      // future per-step ordering). For the partitioned case
      // the key is `${stepId}::${partitionIndex}` so the
      // broker's default partitioner still gives each
      // partition's message a stable key while letting the
      // application-level `partitionIndex` (in the payload)
      // remain the source of truth for fan-out.
      const message: Message = {
        key: isPartition ? `${stepId}::${partitionIndex}` : stepId,
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
      lastQueueJobId = offset;
      this.logger.debug(
        `Produced step "${stepId}" for execution ${ctx.executionId}` +
          (isPartition ? ` (partition ${partitionIndex}/${partitionCount})` : '') +
          ` to Kafka offset ${offset}`,
      );
    }
    if (lastQueueJobId === null) {
      // Defensive: the loop above always runs at least once
      // (partitionOrdinals has length >= 1), so this branch is
      // unreachable in practice. Keep the explicit throw so a
      // future refactor cannot quietly produce zero messages.
      throw new Error(
        `[KafkaRuntimeService] produced zero messages for execution ${ctx.executionId}`,
      );
    }
    return { kind: 'enqueued', queueJobId: lastQueueJobId };
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
   *
   * **Partition routing (T9)**: when the payload carries a
   * `partitionIndex` (i.e. the message was produced for a
   * partitioned step), the consumer validates the index against the
   * step's `partitions.count` via `enforcePartitionIndex` and
   * forwards the `partitionIndex` / `partitionCount` pair to
   * `JobExecutor.execute`. The chunk executor uses this pair
   * (together with the step's `partitions.range` resolver) to
   * bound the read loop to the partition's slice. Absent
   * `partitionIndex` (the 0.1.0 path), the executor runs the
   * non-partitioned chunk pipeline.
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
    //
    // T9: build the partition routing args. When the payload
    // carries a `partitionIndex`, validate it against the start
    // step's `partitions.count` (defensive — the producer side
    // already validated via `validatePartitions`, but the
    // consumer is a public surface and a corrupted / replayed
    // message could arrive with a bad index). The validation
    // throws `InvalidPartitionsError` which the consumer's
    // `eachMessage` re-throws so KafkaJS records the failure
    // and the dead-letter path catches it.
    const startStepId = jobDef.startStepId;
    const startStep = jobDef.steps[startStepId];
    const partitions = startStep?.kind === 'chunk' ? startStep.partitions : undefined;
    const partitionArgs: { partitionIndex?: number; partitionCount?: number } = {};
    if (payload.partitionIndex !== undefined) {
      const count = partitions?.count ?? 1;
      enforcePartitionIndex(payload.partitionIndex, count);
      partitionArgs.partitionIndex = payload.partitionIndex;
      partitionArgs.partitionCount = count;
    }
    await this.jobExecutor.execute(execution, jobDef, partitionArgs);
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
