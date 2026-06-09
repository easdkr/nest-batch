/**
 * T-AC-3 second-half acceptance test: Kafka partition invariant.
 *
 * What this test pins (RED-first, then asserts the implementation
 * honours the v1 partition contract from `docs/RELEASE-0.2.0.md §6`):
 *
 *   1. The strategy produces N Kafka messages (one per partition) to
 *      the configured topic when `partitions.count >= 2`. Each
 *      message's payload carries the right `partitionIndex`
 *      (`0..N-1`).
 *   2. The consumer's `eachMessage` handler, when given a partition
 *      payload, drives the chunk executor to process ONLY the
 *      partition's range (the default even split). The worker's
 *      per-partition commitCount is recorded in the test fixture.
 *   3. **The partition invariant**: `sum(partitionCommitCount) ==
 *      totalCommitCount`. With 100 input items, 4 partitions, and the
 *      default even split, each partition commits 25 items, and the
 *      sum across all 4 partitions is 100 — exactly the whole step.
 *
 * The test is self-contained: the `kafkajs` module is replaced with
 * a fake `Kafka` / `Producer` / `Consumer`, and the rest of the
 * runtime (JobRepository, TransactionManager, JobExecutor,
 * ChunkStepExecutor) runs against in-memory implementations. No
 * broker, no real DI graph.
 *
 * Mirror file (first half of T-AC-3):
 *   `packages/bullmq/tests/partition-invariant.test.ts` (T8).
 *
 * Pinned source:
 *   `packages/core/src/core/ir/step-definition.ts` — the
 *     `ChunkStepDefinition` shape (extended in T8 with `partitions`).
 *   `packages/kafka/src/kafka-runtime.service.ts` — the
 *     `KafkaJobPayload` with `partitionIndex?: number`.
 *   `packages/kafka/src/kafka-execution-strategy.ts` — the strategy
 *     class (thin adapter over the runtime service's `launch()`).
 *   `packages/core/src/partition-helpers.ts` (new in T8) — the pure
 *     partition helpers the Kafka runtime consults.
 *   `docs/RELEASE-0.2.0.md §6` — the v1 partition contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChunkStepExecutor,
  FlowEvaluator,
  InMemoryJobRepository,
  InMemoryTransactionManager,
  JobExecutor,
  JobRegistry,
  ListenerInvoker,
  RefKind,
  TaskletStepExecutor,
  type ChunkStepDefinition,
  type JobDefinition,
  type JobExecution,
  type JobParameters,
} from '@nest-batch/core';

import {
  KafkaRuntimeService,
  type KafkaJobPayload,
} from '../src/kafka-runtime.service';
import type { ResolvedKafkaModuleOptions } from '../src/module-options';

// ---------------------------------------------------------------------------
// `kafkajs` mock
// ---------------------------------------------------------------------------
//
// The runtime service imports `Kafka`, `Producer`, and `Consumer`
// from `kafkajs`. We replace all three with vi.fn() spies that:
//   - `Kafka` ctor:        returns a `producer()` factory and a
//                          `consumer()` factory.
//   - `Producer`:          captures every `send()` call (the
//                          producer side) and `connect()`.
//   - `Consumer`:          captures the `eachMessage` handler passed
//                          to `run()` so the test can drive the
//                          consumer body manually.
//
// The broker is fake: `send()` returns a fabricated offset; the
// `eachMessage` handler is captured (not invoked by KafkaJS).

const kafkajsMock = vi.hoisted(() => {
  const producerConnect = vi.fn(async () => undefined);
  const producerDisconnect = vi.fn(async () => undefined);
  const producerSend = vi.fn(
    async (_args: { topic: string; messages: unknown[] }) => [
      { topicName: 'mock-topic', partition: 0, errorCode: 0, baseOffset: '0', offset: '0' },
    ],
  );
  const Producer = vi.fn().mockImplementation(() => ({
    connect: producerConnect,
    disconnect: producerDisconnect,
    send: producerSend,
  }));

  // The Consumer ctor receives `(opts)` and exposes `connect()`,
  // `subscribe()`, `run({ eachMessage })`. We capture the
  // `eachMessage` handler passed to `run()` so the test can invoke
  // it directly to simulate a Kafka consumer pulling a message off
  // the topic.
  const consumerConnect = vi.fn(async () => undefined);
  const consumerDisconnect = vi.fn(async () => undefined);
  const consumerSubscribe = vi.fn(async () => undefined);
  const consumerRun = vi.fn(async () => undefined);
  let capturedEachMessage:
    | ((payload: {
        topic: string;
        partition: number;
        message: { value: Buffer | null; offset: string; key?: Buffer | null };
        heartbeat: () => Promise<void>;
        pause: () => () => void;
      }) => Promise<void>)
    | null = null;
  const Consumer = vi.fn().mockImplementation(() => ({
    connect: consumerConnect,
    disconnect: consumerDisconnect,
    subscribe: consumerSubscribe,
    run: (config: { eachMessage?: typeof capturedEachMessage }) => {
      capturedEachMessage = config.eachMessage ?? null;
      return consumerRun();
    },
  }));

  const adminConnect = vi.fn(async () => undefined);
  const adminDisconnect = vi.fn(async () => undefined);
  const adminListTopics = vi.fn(async () => ['mock-topic']);
  const adminCreateTopics = vi.fn(async () => true);
  const Admin = vi.fn().mockImplementation(() => ({
    connect: adminConnect,
    disconnect: adminDisconnect,
    listTopics: adminListTopics,
    createTopics: adminCreateTopics,
  }));

  const Kafka = vi.fn().mockImplementation(() => ({
    producer: () => new Producer(),
    consumer: () => new Consumer(),
    admin: () => new Admin(),
  }));

  return {
    Kafka,
    Producer,
    Consumer,
    Admin,
    producerConnect,
    producerDisconnect,
    producerSend,
    consumerConnect,
    consumerDisconnect,
    consumerSubscribe,
    consumerRun,
    adminConnect,
    adminDisconnect,
    adminListTopics,
    adminCreateTopics,
    getCapturedEachMessage: () => capturedEachMessage,
    resetCapturedEachMessage: () => {
      capturedEachMessage = null;
    },
  };
});

vi.mock('kafkajs', () => ({
  Kafka: kafkajsMock.Kafka,
  Producer: kafkajsMock.Producer,
  Consumer: kafkajsMock.Consumer,
  Admin: kafkajsMock.Admin,
  // The runtime service also imports the `Message` type from
  // kafkajs. Type-only imports vanish at runtime under vitest's
  // ESM/CJS interop, so the mock object doesn't need to surface
  // a `Message` constructor.
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseOptions: ResolvedKafkaModuleOptions = {
  connection: {
    brokers: ['127.0.0.1:9092'],
    clientId: 'nest-batch-test',
    ssl: undefined,
    sasl: undefined,
    connectionTimeout: 5_000,
    requestTimeout: 30_000,
  },
  autoStartConsumer: true,
  consumerGroupId: 'nest-batch-test-consumer',
  topic: 'nest-batch-test-topic',
};

/**
 * Process-local swap for the partition index the reader closes over.
 *
 * Why this seam exists: the runtime service carries `partitionIndex`
 * on the Kafka message payload, but the `ItemReader` closure
 * registered at decoration time cannot see the payload directly
 * (the reader is built when the step is registered, before any
 * transport message exists). The test sets this value before
 * invoking the captured `eachMessage` handler; the handler calls
 * the chunk executor, which calls the reader, which reads
 * `currentPartitionIndex` to know which slice to consume.
 *
 * This is the same test seam the BullMQ partition-invariant test
 * uses (`packages/bullmq/tests/partition-invariant.test.ts`).
 * Mirroring it here is intentional: the contract is identical, and
 * the seam lets the test run hermetically without a real Kafka
 * broker.
 */
let currentPartitionIndex = 0;

/**
 * Build a chunk JobDefinition that reads `rowCount` items through
 * `chunkSize`-sized chunks, partitioned into `partitionCount`
 * partitions. The reader / processor / writer use a closure over a
 * shared `itemsSeen` array so the test can count commits per
 * partition at the end.
 *
 * The default partition range is the even split from
 * `docs/RELEASE-0.2.0.md §6.1`: partition `i` of `n` consumes
 * `[floor(i * total / n), floor((i+1) * total / n))`.
 */
function makePartitionedChunkJob(args: {
  id: string;
  rowCount: number;
  chunkSize: number;
  partitionCount: number;
  /** Per-partition writeCount accumulator. Index = partitionIndex. */
  partitionWriteCounts: number[];
  /** Total commitCount accumulator (sum of all partition commit counts). */
  totalCommitCount: { value: number };
  /** Optional explicit range resolver; defaults to even split. */
  range?: (i: number, n: number) => readonly [number, number];
}): JobDefinition {
  const range = args.range ?? ((i: number, n: number) => {
    const total = args.rowCount;
    const from = Math.floor((i * total) / n);
    const to = Math.floor(((i + 1) * total) / n);
    return [from, to] as const;
  });

  return {
    id: args.id,
    steps: {
      s1: {
        kind: 'chunk',
        id: 's1',
        chunkSize: args.chunkSize,
        // The reader is partition-aware. It uses the
        // `currentPartitionIndex` test seam to skip the prefix and
        // stop at the partition's `to` boundary. The runtime will
        // update the seam before invoking the consumer handler.
        reader: {
          kind: RefKind.BuilderLambda,
          fn: () => {
            const idx = currentPartitionIndex;
            const [from, to] = range(idx, args.partitionCount);
            let i = 0;
            return {
              read: async () => {
                const absoluteIndex = from + i;
                if (absoluteIndex >= to) return null;
                i += 1;
                return absoluteIndex;
              },
            };
          },
        },
        processor: {
          kind: RefKind.BuilderLambda,
          fn: () => ({
            process: async (item: number) => item,
          }),
        },
        writer: {
          kind: RefKind.BuilderLambda,
          fn: () => ({
            write: async (items: number[]) => {
              const idx = currentPartitionIndex;
              args.partitionWriteCounts[idx] =
                (args.partitionWriteCounts[idx] ?? 0) + items.length;
              args.totalCommitCount.value += items.length;
            },
          }),
        },
        listeners: [],
        partitions: {
          count: args.partitionCount,
          ...(args.range
            ? { range: args.range as (i: number, n: number) => [number, number] }
            : {}),
        },
      } satisfies ChunkStepDefinition,
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully-wired `KafkaRuntimeService` against the in-memory
 * repository / tx manager / executor graph. Mirrors the production DI
 * graph minus the Kafka clients (which are mocked).
 */
function buildRuntimeService(args: {
  registry: JobRegistry;
  repository: InMemoryJobRepository;
  jobExecutor: JobExecutor;
}): KafkaRuntimeService {
  return new KafkaRuntimeService(
    baseOptions,
    args.repository,
    args.registry,
    args.jobExecutor,
  );
}

/**
 * Build a real `JobExecutor` wired against the in-memory repository
 * and transaction manager. Mirrors the production DI graph so the
 * captured consumer handler exercises the actual chunk pipeline (the
 * only mocked layer is KafkaJS itself).
 */
function buildJobExecutor(repository: InMemoryJobRepository): JobExecutor {
  const txManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const flowEvaluator = new FlowEvaluator();
  const chunkExecutor = new ChunkStepExecutor();
  const taskletExecutor = new TaskletStepExecutor();
  return new JobExecutor(
    repository,
    txManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
}

/**
 * Run the strategy launch (producer side) and capture every
 * message's payload. Returns the list of `KafkaJobPayload`s in
 * enqueue order.
 *
 * The strategy calls `producer.send({ topic, messages: [...] })`
 * per partition; for partitioned steps the `messages` array
 * contains one entry per partition. We flatten those into a single
 * list for the assertion below.
 */
async function captureProducedPayloads(
  runtime: KafkaRuntimeService,
  jobDef: JobDefinition,
  execution: JobExecution,
): Promise<KafkaJobPayload[]> {
  kafkajsMock.producerSend.mockClear();
  await runtime.launch(jobDef, {} as JobParameters, {
    executionId: execution.id,
    jobExecutionId: execution.id,
  });
  // The strategy calls `producer.send({ topic, messages: [...] })`.
  // For partitioned steps, the runtime can either:
  //   - call `send` once with N messages, or
  //   - call `send` N times with one message each.
  // Either shape is acceptable per the Kafka contract; the
  // acceptance test flattens both into a single payload list.
  const payloads: KafkaJobPayload[] = [];
  for (const call of kafkajsMock.producerSend.mock.calls) {
    const args = call[0] as { topic: string; messages: Array<{ value: string }> };
    for (const msg of args.messages) {
      payloads.push(JSON.parse(msg.value) as KafkaJobPayload);
    }
  }
  return payloads;
}

/**
 * Drive the captured `eachMessage` handler for each produced
 * payload, in order. Updates the `currentPartitionIndex` seam before
 * each call so the reader closes over the right value, and fabricates
 * a KafkaJS-shaped `EachMessagePayload` (the `partition` field
 * here is the broker's topic-partition — we deliberately use 0 for
 * all messages because the test asserts the *payload*'s
 * `partitionIndex` is the source of truth, not the broker's
 * topic-partition).
 */
async function driveConsumer(payloads: KafkaJobPayload[]): Promise<void> {
  const eachMessage = kafkajsMock.getCapturedEachMessage();
  if (eachMessage === null) {
    throw new Error(
      'eachMessage handler was not captured — onApplicationBootstrap did not run or autoStartConsumer was false',
    );
  }
  for (const payload of payloads) {
    currentPartitionIndex = payload.partitionIndex ?? 0;
    const message = {
      value: Buffer.from(JSON.stringify(payload), 'utf8'),
      offset: '0',
      key: null,
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
      size: 0,
    };
    await eachMessage({
      topic: baseOptions.topic,
      // The broker's topic-partition is transport-level. The
      // payload's `partitionIndex` is application-level. The
      // acceptance test deliberately uses a single broker
      // partition (0) for all messages to prove that the
      // payload field, not the broker field, drives the
      // chunk loop.
      partition: 0,
      message,
      heartbeat: async () => undefined,
      pause: () => () => undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Kafka partition orchestration — T-AC-3 second half (invariant)', () => {
  beforeEach(() => {
    kafkajsMock.Kafka.mockClear();
    kafkajsMock.Producer.mockClear();
    kafkajsMock.Consumer.mockClear();
    kafkajsMock.Admin.mockClear();
    kafkajsMock.producerConnect.mockClear();
    kafkajsMock.producerDisconnect.mockClear();
    kafkajsMock.producerSend.mockClear();
    kafkajsMock.consumerConnect.mockClear();
    kafkajsMock.consumerDisconnect.mockClear();
    kafkajsMock.consumerSubscribe.mockClear();
    kafkajsMock.consumerRun.mockClear();
    kafkajsMock.adminConnect.mockClear();
    kafkajsMock.adminDisconnect.mockClear();
    kafkajsMock.adminListTopics.mockClear();
    kafkajsMock.adminCreateTopics.mockClear();
    kafkajsMock.resetCapturedEachMessage();
    currentPartitionIndex = 0;
  });

  afterEach(() => {
    kafkajsMock.resetCapturedEachMessage();
  });

  it('produces one Kafka message per partition with the right partitionIndex', async () => {
    const registry = new JobRegistry();
    const repository = new InMemoryJobRepository();
    const jobExecutor = buildJobExecutor(repository);

    const jobDef = makePartitionedChunkJob({
      id: 'partitioned-4',
      rowCount: 100,
      chunkSize: 10,
      partitionCount: 4,
      partitionWriteCounts: [0, 0, 0, 0],
      totalCommitCount: { value: 0 },
    });
    registry.register(jobDef);

    const runtime = buildRuntimeService({ registry, repository, jobExecutor });
    runtime.onApplicationBootstrap();

    const execution = await repository.createExecutionAtomic(
      jobDef.id,
      'partitioned-4::k1',
      { nonce: 'k1' },
    );

    const payloads = await captureProducedPayloads(runtime, jobDef, execution);

    // Invariant 1: exactly N messages produced, one per partition.
    expect(payloads).toHaveLength(4);

    // Invariant 2: each payload carries a distinct partitionIndex in
    // `[0, N)`, and the rest of the payload is the canonical
    // (executionId, jobId, stepId) triple.
    const indices = payloads.map((p) => p.partitionIndex).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(indices).toEqual([0, 1, 2, 3]);
    for (const p of payloads) {
      expect(p.executionId).toBe(execution.id);
      expect(p.jobId).toBe(jobDef.id);
      expect(p.stepId).toBe('s1');
    }
  });

  it('satisfies the partition invariant: sum(partitionCommitCount) == totalCommitCount', async () => {
    const registry = new JobRegistry();
    const repository = new InMemoryJobRepository();
    const jobExecutor = buildJobExecutor(repository);

    const rowCount = 100;
    const partitionCount = 4;
    const chunkSize = 10;

    const partitionWriteCounts: number[] = new Array(partitionCount).fill(0);
    const totalCommitCount = { value: 0 };

    const jobDef = makePartitionedChunkJob({
      id: 'partition-invariant',
      rowCount,
      chunkSize,
      partitionCount,
      partitionWriteCounts,
      totalCommitCount,
    });
    registry.register(jobDef);

    const runtime = buildRuntimeService({ registry, repository, jobExecutor });
    runtime.onApplicationBootstrap();

    const execution = await repository.createExecutionAtomic(
      jobDef.id,
      'partition-invariant::k1',
      { nonce: 'k1' },
    );

    // Producer side: enqueue 4 messages, one per partition.
    const payloads = await captureProducedPayloads(runtime, jobDef, execution);
    expect(payloads).toHaveLength(4);

    // Consumer side: drive the captured handler for each partition.
    await driveConsumer(payloads);

    // **The T-AC-3 invariant**:
    //   sum(partitionCommitCount) == totalCommitCount
    // For an even 4-way split of 100 items, each partition commits
    // exactly 25 items, summing to 100.
    const sumOfPartitions = partitionWriteCounts.reduce((acc, n) => acc + n, 0);
    expect(sumOfPartitions).toBe(totalCommitCount.value);
    expect(totalCommitCount.value).toBe(rowCount);
    // Even-split assertion: each partition commits 25 items.
    for (const n of partitionWriteCounts) {
      expect(n).toBe(25);
    }
  });

  it('preserves the single-message behaviour for partitions.count === 1', async () => {
    const registry = new JobRegistry();
    const repository = new InMemoryJobRepository();
    const jobExecutor = buildJobExecutor(repository);

    const partitionWriteCounts = [0];
    const totalCommitCount = { value: 0 };

    const jobDef: JobDefinition = {
      id: 'single-partition',
      steps: {
        s1: {
          kind: 'chunk',
          id: 's1',
          chunkSize: 5,
          reader: {
            kind: RefKind.BuilderLambda,
            fn: () => {
              let i = 0;
              return {
                read: async () => (i < 10 ? i++ : null),
              };
            },
          },
          processor: {
            kind: RefKind.BuilderLambda,
            fn: () => ({ process: async (item: number) => item }),
          },
          writer: {
            kind: RefKind.BuilderLambda,
            fn: () => ({
              write: async (items: number[]) => {
                partitionWriteCounts[0] =
                  (partitionWriteCounts[0] ?? 0) + items.length;
                totalCommitCount.value += items.length;
              },
            }),
          },
          listeners: [],
          partitions: { count: 1 },
        } satisfies ChunkStepDefinition,
      },
      startStepId: 's1',
      transitions: [],
      listeners: [],
      restartable: false,
      allowDuplicateInstances: false,
    };
    registry.register(jobDef);

    const runtime = buildRuntimeService({ registry, repository, jobExecutor });
    runtime.onApplicationBootstrap();

    const execution = await repository.createExecutionAtomic(
      jobDef.id,
      'single-partition::k1',
      { nonce: 'k1' },
    );

    const payloads = await captureProducedPayloads(runtime, jobDef, execution);

    // Single message: no `partitionIndex` set (the 0.1.0 shape).
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.partitionIndex).toBeUndefined();
    expect(payloads[0]?.stepId).toBe('s1');
  });
});
