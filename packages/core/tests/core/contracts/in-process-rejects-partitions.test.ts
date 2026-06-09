/**
 * Contract test: `InProcessExecutionStrategy` must reject (or warn
 * about) chunk steps with `partitions.count > 1`.
 *
 * Pinned by `docs/RELEASE-0.2.0.md §6.3` and the T8 acceptance
 * criteria:
 *
 *   - Default mode (`onPartitionViolation: 'throw'`): the
 *     `launch()` call MUST throw
 *     `InProcessPartitionsNotSupportedError` with the documented
 *     `code`. The host gets a loud failure rather than a silent
 *     single-partition execution.
 *   - Opt-in mode (`onPartitionViolation: 'warn'`): the
 *     `launch()` call must NOT throw; the strategy must log a
 *     warning and proceed with a single-partition execution.
 *
 * The test wires a real `JobExecutor` against the in-memory
 * repository / transaction manager and a chunk step that reads
 * 5 items. The `assertPartitionsSupported` guard fires before
 * the executor is even invoked, so a 'warn'-mode execution
 * reaches `COMPLETED` and the item count is observable.
 */
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { RefKind, type ChunkStepDefinition, type JobDefinition } from '../../../src/core/ir';
import {
  InProcessExecutionStrategy,
  InProcessPartitionsNotSupportedError,
  type InProcessPartitionViolationMode,
} from '../../../src/execution/in-process-execution-strategy';
import { JobExecutor } from '../../../src/execution/job-executor';
import { ChunkStepExecutor } from '../../../src/execution/chunk-step-executor';
import { TaskletStepExecutor } from '../../../src/execution/tasklet-step-executor';
import { ListenerInvoker } from '../../../src/execution/listener-invoker';
import { FlowEvaluator } from '../../../src/flow/flow-evaluator';
import { InMemoryJobRepository } from '../../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../../src/transaction/in-memory-transaction-manager';
import type { ExecutionStrategyContext } from '../../../src/execution/execution-strategy';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePartitionedChunkJob(args: {
  id: string;
  partitionCount: number;
  items?: number[];
}): JobDefinition {
  const items = args.items ?? [0, 1, 2, 3, 4];
  return {
    id: args.id,
    steps: {
      s1: {
        kind: 'chunk',
        id: 's1',
        chunkSize: 10,
        reader: {
          kind: RefKind.BuilderLambda,
          fn: () => {
            let i = 0;
            return {
              read: async () => (i < items.length ? (items[i++] as number) : null),
            };
          },
        },
        writer: {
          kind: RefKind.BuilderLambda,
          fn: () => ({
            write: async (chunk: number[]) => {
              void chunk;
            },
          }),
        },
        listeners: [],
        partitions: { count: args.partitionCount },
      } satisfies ChunkStepDefinition,
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

function makeNonPartitionedJob(id: string): JobDefinition {
  return makePartitionedChunkJob({ id, partitionCount: 1 });
}

function buildStrategy(
  mode: InProcessPartitionViolationMode,
): { strategy: InProcessExecutionStrategy; repository: InMemoryJobRepository } {
  const repository = new InMemoryJobRepository();
  const txManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const flowEvaluator = new FlowEvaluator();
  const chunkExecutor = new ChunkStepExecutor();
  const taskletExecutor = new TaskletStepExecutor();
  const jobExecutor = new JobExecutor(
    repository,
    txManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
  const strategy = new InProcessExecutionStrategy(repository, jobExecutor, mode);
  return { strategy, repository };
}

async function seedExecution(
  repository: InMemoryJobRepository,
  job: JobDefinition,
  jobKey: string,
) {
  return repository.createExecutionAtomic(job.id, jobKey, { nonce: jobKey });
}

const dummyCtx: ExecutionStrategyContext = {
  executionId: '00000000-0000-0000-0000-000000000000',
  jobExecutionId: '00000000-0000-0000-0000-000000000000',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InProcessExecutionStrategy partition guard — T8 contract', () => {
  it('throws InProcessPartitionsNotSupportedError on partitions.count > 1 by default', async () => {
    const { strategy, repository } = buildStrategy('throw');
    const job = makePartitionedChunkJob({ id: 'partitioned-3', partitionCount: 3 });
    const execution = await seedExecution(repository, job, 'k1');

    let caught: unknown = null;
    try {
      await strategy.launch(job, {}, { ...dummyCtx, executionId: execution.id });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InProcessPartitionsNotSupportedError);
    expect((caught as InProcessPartitionsNotSupportedError).code).toBe(
      'IN_PROCESS_PARTITIONS_NOT_SUPPORTED',
    );
    expect((caught as Error).message).toContain('s1');
    expect((caught as Error).message).toContain('count=3');
  });

  it('does not throw on partitions.count === 1 (preserves 0.1.0 behaviour)', async () => {
    const { strategy, repository } = buildStrategy('throw');
    const job = makeNonPartitionedJob('non-partitioned');
    const execution = await seedExecution(repository, job, 'k1');

    const result = await strategy.launch(job, {}, { ...dummyCtx, executionId: execution.id });
    expect(result.kind).toBe('completed');
  });

  it('does not throw when partitions is absent (preserves 0.1.0 behaviour)', async () => {
    const { strategy, repository } = buildStrategy('throw');
    const job: JobDefinition = {
      id: 'no-partitions',
      steps: {
        s1: {
          kind: 'chunk',
          id: 's1',
          chunkSize: 10,
          reader: {
            kind: RefKind.BuilderLambda,
            fn: () => {
              let i = 0;
              return {
                read: async () => (i < 3 ? (i++ as number) : null),
              };
            },
          },
          writer: {
            kind: RefKind.BuilderLambda,
            fn: () => ({ write: async (c: number[]) => void c }),
          },
          listeners: [],
        },
      },
      startStepId: 's1',
      transitions: [],
      listeners: [],
      restartable: false,
      allowDuplicateInstances: false,
    };
    const execution = await seedExecution(repository, job, 'k1');

    const result = await strategy.launch(job, {}, { ...dummyCtx, executionId: execution.id });
    expect(result.kind).toBe('completed');
  });

  it('logs a warning and proceeds when onPartitionViolation === "warn"', async () => {
    const { strategy, repository } = buildStrategy('warn');
    const job = makePartitionedChunkJob({ id: 'partitioned-2', partitionCount: 2 });
    const execution = await seedExecution(repository, job, 'k1');

    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await strategy.launch(job, {}, {
        ...dummyCtx,
        executionId: execution.id,
      });
      expect(result.kind).toBe('completed');
      const messages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''));
      expect(
        messages.some(
          (m) =>
            m.includes('s1') && m.includes('partitions.count=2') && m.includes('single partition'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
