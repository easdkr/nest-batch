/**
 * T-AC-3 first-half acceptance test: BullMQ partition invariant.
 *
 * What this test pins (RED-first, then asserts the implementation
 * honours the v1 partition contract from `docs/RELEASE-0.2.0.md §6`):
 *
 *   1. The strategy enqueues N BullMQ jobs (one per partition) when
 *      `partitions.count >= 2`. Each job's payload carries the right
 *      `partitionIndex` (`0..N-1`).
 *   2. The worker body, when given a partition payload, drives the
 *      chunk executor to process ONLY the partition's range (the
 *      default even split). The worker's per-partition commitCount
 *      is recorded in the test fixture.
 *   3. **The partition invariant**: `sum(partitionCommitCount) ==
 *      totalCommitCount`. With 100 input items, 4 partitions, and the
 *      default even split, each partition commits 25 items, and the
 *      sum across all 4 partitions is 100 — exactly the whole step.
 *
 * The test is self-contained: the `bullmq` module is replaced with a
 * fake `Queue` / `Worker` / `QueueEvents`, and the rest of the runtime
 * (JobRepository, TransactionManager, JobExecutor, ChunkStepExecutor)
 * runs against in-memory implementations. No Redis, no real DI graph.
 *
 * Mirror file (second half of T-AC-3):
 *   `packages/kafka/tests/partition-invariant.test.ts` (T9).
 *
 * Pinned source:
 *   `packages/core/src/core/ir/step-definition.ts:6-16` — the
 *     `ChunkStepDefinition` shape (extended in T8 with `partitions`).
 *   `packages/bullmq/src/bullmq-runtime.service.ts:42-61` — the
 *     `BullmqJobPayload` with `partitionIndex?: number`.
 *   `packages/bullmq/src/bullmq-execution-strategy.ts:41-46` — the
 *     "one job per step" enforcement comment that T8 inverts.
 *   `packages/core/src/partition-helpers.ts` (new in T8) — the pure
 *     partition helpers the runtime consults.
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
  BullmqRuntimeService,
  type BullmqJobPayload,
} from '../src/bullmq-runtime.service';
import type { ResolvedBullMqModuleOptions } from '../src/module-options';

// ---------------------------------------------------------------------------
// `bullmq` mock
// ---------------------------------------------------------------------------
//
// The runtime service imports `Queue`, `QueueEvents`, and `Worker` from
// `bullmq`. We replace all three with vi.fn() spies that:
//   - `Queue` ctor:        captures every `add()` call (the producer side)
//   - `Worker` ctor:       captures the per-job processor handler (so the
//                          test can drive the worker body manually)
//   - `QueueEvents` ctor:  no-op (the observer bridge is not exercised)

const bullmqMock = vi.hoisted(() => {
  const queueAdd = vi.fn(async (_name: string, _data: unknown) => ({
    id: 'mock-job-id',
    name: _name,
    data: _data,
  }));
  const queueClose = vi.fn(async () => undefined);
  const Queue = vi.fn().mockImplementation(() => ({
    add: queueAdd,
    close: queueClose,
  }));

  // The Worker ctor receives `(queueName, processor, opts)`. We capture
  // the processor (a function) so the test can invoke it directly to
  // simulate a BullMQ worker pulling a job off the queue.
  const workerClose = vi.fn(async () => undefined);
  let capturedProcessor: ((job: { data: BullmqJobPayload }) => Promise<void>) | null = null;
  const Worker = vi.fn().mockImplementation(
    (
      _name: string,
      processor: (job: { data: BullmqJobPayload }) => Promise<void>,
      _opts: unknown,
    ) => {
      capturedProcessor = processor;
      return { close: workerClose };
    },
  );

  const queueEventsClose = vi.fn(async () => undefined);
  const QueueEvents = vi.fn().mockImplementation(() => ({
    on: () => undefined,
    close: queueEventsClose,
  }));

  return {
    Queue,
    queueAdd,
    queueClose,
    Worker,
    workerClose,
    getCapturedProcessor: () => capturedProcessor,
    resetCapturedProcessor: () => {
      capturedProcessor = null;
    },
    QueueEvents,
    queueEventsClose,
  };
});

vi.mock('bullmq', () => ({
  Queue: bullmqMock.Queue,
  Worker: bullmqMock.Worker,
  QueueEvents: bullmqMock.QueueEvents,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseOptions: ResolvedBullMqModuleOptions = {
  connection: {
    host: '127.0.0.1',
    port: 6379,
    password: undefined,
    username: undefined,
    db: 0,
    keyPrefix: 'nest-batch-test:',
    tls: false,
  },
  autoStartWorker: true,
};

/**
 * Process-local swap for the partition index the reader closes over.
 * The runtime service carries `partitionIndex` on the job payload, but
 * the reader closure cannot see it directly. The test sets this before
 * invoking the captured Worker handler; the handler calls the chunk
 * executor, which calls the reader, which reads `currentPartitionIndex`
 * to know which slice to consume.
 *
 * This is the test seam the partition contract uses: the worker's
 * `partitionIndex` selects the input range, the reader honours that
 * range, and the writer counts what each partition committed.
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
        // update the seam before invoking the worker handler.
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
 * Build a fully-wired `BullmqRuntimeService` against the in-memory
 * repository / tx manager / executor graph. Mirrors the production DI
 * graph minus the BullMQ clients (which are mocked).
 */
function buildRuntimeService(args: {
  registry: JobRegistry;
  repository: InMemoryJobRepository;
  jobExecutor: JobExecutor;
}): BullmqRuntimeService {
  return new BullmqRuntimeService(
    baseOptions,
    args.repository,
    args.registry,
    args.jobExecutor,
  );
}

/**
 * Build a real `JobExecutor` wired against the in-memory repository
 * and transaction manager. Mirrors the production DI graph so the
 * captured Worker handler exercises the actual chunk pipeline (the
 * only mocked layer is BullMQ itself).
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
 * Run the strategy launch (producer side) and capture every job's
 * payload. Returns the list of `BullmqJobPayload`s in enqueue order.
 */
async function captureEnqueuedPayloads(
  runtime: BullmqRuntimeService,
  jobDef: JobDefinition,
  execution: JobExecution,
): Promise<BullmqJobPayload[]> {
  bullmqMock.queueAdd.mockClear();
  await runtime.launch(jobDef, {} as JobParameters, {
    executionId: execution.id,
    jobExecutionId: execution.id,
  });
  // The strategy calls `queue.add(name, payload, opts)` per partition.
  // We return just the payloads (2nd arg) for the assertion below.
  return bullmqMock.queueAdd.mock.calls.map((call) => call[1] as BullmqJobPayload);
}

/**
 * Drive the captured Worker handler for each enqueued payload, in
 * order. Updates the `currentPartitionIndex` seam before each call so
 * the reader closes over the right value.
 */
async function driveWorker(payloads: BullmqJobPayload[]): Promise<void> {
  const processor = bullmqMock.getCapturedProcessor();
  if (processor === null) {
    throw new Error('Worker handler was not captured — onApplicationBootstrap did not run');
  }
  for (const payload of payloads) {
    currentPartitionIndex = payload.partitionIndex ?? 0;
    await processor({ data: payload });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BullMQ partition orchestration — T-AC-3 first half (invariant)', () => {
  beforeEach(() => {
    bullmqMock.Queue.mockClear();
    bullmqMock.Worker.mockClear();
    bullmqMock.QueueEvents.mockClear();
    bullmqMock.queueAdd.mockClear();
    bullmqMock.queueClose.mockClear();
    bullmqMock.workerClose.mockClear();
    bullmqMock.queueEventsClose.mockClear();
    bullmqMock.resetCapturedProcessor();
    currentPartitionIndex = 0;
  });

  afterEach(() => {
    bullmqMock.resetCapturedProcessor();
  });

  it('enqueues one BullMQ job per partition with the right partitionIndex', async () => {
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

    const payloads = await captureEnqueuedPayloads(runtime, jobDef, execution);

    // Invariant 1: exactly N jobs enqueued, one per partition.
    expect(bullmqMock.queueAdd).toHaveBeenCalledTimes(4);

    // Invariant 2: each payload carries a distinct partitionIndex in
    // `[0, N)`, and the rest of the payload is the canonical
    // (executionId, jobId, stepId) triple.
    const indices = payloads.map((p) => p.partitionIndex).sort();
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

    // Producer side: enqueue 4 jobs, one per partition.
    const payloads = await captureEnqueuedPayloads(runtime, jobDef, execution);
    expect(payloads).toHaveLength(4);

    // Worker side: drive the captured handler for each partition.
    await driveWorker(payloads);

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
});
