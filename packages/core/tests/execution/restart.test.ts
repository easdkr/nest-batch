import { describe, expect, test } from 'vitest';
import { JobLauncher } from '../../src/execution/job-launcher';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { JobRegistry } from '../../src/registry/job-registry';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { RefKind, type JobDefinition, type ChunkStepDefinition } from '../../src/core/ir';
import type { ItemReader, ItemStream, ItemWriter } from '../../src/core/item';
import type { ExecutionContext } from '../../src/core/repository';
import { JobStatus, StepStatus } from '../../src/core/status';
import { JobNotRestartableError } from '../../src/core/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class ArrayReader implements ItemReader<number> {
  private i = 0;
  constructor(private readonly items: number[]) {}
  async read(): Promise<number | null> {
    return this.i < this.items.length ? (this.items[this.i++] as number) : null;
  }
}

class RecordingWriter implements ItemWriter<number> {
  public readonly chunks: number[][] = [];
  async write(items: number[]): Promise<void> {
    this.chunks.push([...items]);
  }
}

class RestartableArrayReader implements ItemReader<number>, ItemStream {
  private i = 0;
  public readonly openContexts: ExecutionContext[] = [];
  constructor(private readonly items: number[]) {}
  async open(context: ExecutionContext): Promise<void> {
    this.openContexts.push(context);
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    const cursor = (data as { cursor?: unknown }).cursor;
    this.i = typeof cursor === 'number' ? cursor : 0;
  }
  async read(): Promise<number | null> {
    return this.i < this.items.length ? (this.items[this.i++] as number) : null;
  }
  async update(context: ExecutionContext): Promise<ExecutionContext> {
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    return {
      ...context,
      data: {
        ...data,
        cursor: this.i,
      },
    };
  }
  async close(): Promise<void> {}
}

/** A writer that fails on the 0-based call index `failOnCall` (0 = first call). */
class FlakyWriter implements ItemWriter<number> {
  public callCount = 0;
  public readonly chunks: number[][] = [];
  constructor(
    private readonly failOnCall: number,
    private readonly error: Error = new Error('flaky'),
  ) {}
  async write(items: number[]): Promise<void> {
    this.callCount += 1;
    if (this.callCount === this.failOnCall + 1) throw this.error;
    this.chunks.push([...items]);
  }
}

function chunkStep(id: string, chunkSize: number): ChunkStepDefinition {
  return {
    kind: 'chunk',
    id,
    chunkSize,
    reader: { kind: RefKind.Method, classToken: 'Reader', methodName: 'read' },
    writer: { kind: RefKind.Method, classToken: 'Writer', methodName: 'write' },
    listeners: [],
  };
}

function chunkJobDef(id: string, opts: { restartable: boolean }): JobDefinition {
  return {
    id,
    steps: { s1: chunkStep('s1', 2) },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: opts.restartable,
    allowDuplicateInstances: false,
  };
}

/**
 * Build a JobLauncher + registry wired against the in-memory adapter. The
 * reader and writer are registered as resolver entries so the chunk
 * step's Method refs can find them at execution time.
 */
function buildLauncher(
  reader: ItemReader<number>,
  writer: ItemWriter<number>,
): {
  launcher: JobLauncher;
  registry: JobRegistry;
  repository: InMemoryJobRepository;
} {
  const repository = new InMemoryJobRepository();
  const transactionManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const taskletExecutor = new TaskletStepExecutor();
  const chunkExecutor = new ChunkStepExecutor();
  const flowEvaluator = new FlowEvaluator();
  const jobExecutor = new JobExecutor(
    repository,
    transactionManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
  const registry = new JobRegistry();
  const launcher = new JobLauncher(registry, repository, jobExecutor);

  // Register the reader / writer against the launcher's underlying
  // chunkExecutor by monkey-patching the resolvers arg at execute time.
  // The JobExecutor passes an empty resolvers map today; we patch the
  // chunkExecutor so it can find our fixtures by class name. The
  // resolver key is namespaced by `context.jobExecutionId2`, so we
  // mirror that prefix here.
  const origExecute = chunkExecutor.execute.bind(chunkExecutor);
  (chunkExecutor as unknown as { execute: typeof origExecute }).execute = ((
    step: ChunkStepDefinition,
    context: Parameters<typeof origExecute>[1],
  ) => {
    const resolvers = new Map(context.resolvers);
    const ns = context.jobExecutionId2;
    const readerKey = `${ns}::reader::Reader::read`;
    const writerKey = `${ns}::writer::Writer::write`;
    if (!resolvers.has(readerKey)) {
      resolvers.set(
        readerKey,
        reader.read.bind(reader) as (...args: unknown[]) => unknown | Promise<unknown>,
      );
      resolvers.set(
        writerKey,
        writer.write.bind(writer) as (...args: unknown[]) => unknown | Promise<unknown>,
      );
    }
    return origExecute(step, { ...context, resolvers });
  }) as typeof origExecute;

  return { launcher, registry, repository };
}

/**
 * Create a JobExecution already in FAILED status (simulating the tail
 * state of a prior run that crashed). The execution is wired to a
 * real instance + params, just with the status set by hand.
 */
async function makeFailedExecution(
  repository: InMemoryJobRepository,
  jobName: string,
): Promise<{ instanceId: string; executionId: string }> {
  const inst = await repository.getOrCreateJobInstance(jobName, 'k');
  const exec = await repository.createJobExecution(inst.id, {});
  await repository.updateJobExecution(exec.id, {
    status: JobStatus.FAILED,
    endTime: new Date(),
    exitCode: 'FAILED',
    exitMessage: 'prior run failed',
  });
  return { instanceId: inst.id, executionId: exec.id };
}

describe('JobExecutor restart support', () => {
  // -------------------------------------------------------------------------
  // Test 1: launch with restartable: false (default) + existing FAILED
  // execution → throws JobNotRestartableError
  // -------------------------------------------------------------------------
  test('1) restartable: false + FAILED execution → throws JobNotRestartableError', async () => {
    const writer = new RecordingWriter();
    const { launcher, repository } = buildLauncher(new ArrayReader([1, 2, 3]), writer);
    const { executionId } = await makeFailedExecution(repository, 'restart-disabled');
    const jobDef = chunkJobDef('restart-disabled', { restartable: false });
    const execution = await repository.getJobExecution(executionId);
    expect(execution).not.toBeNull();
    expect(execution!.status).toBe(JobStatus.FAILED);

    await expect(launcher.run(execution!, jobDef)).rejects.toBeInstanceOf(JobNotRestartableError);

    try {
      await launcher.run(execution!, jobDef);
    } catch (err) {
      expect(err).toBeInstanceOf(JobNotRestartableError);
      expect((err as JobNotRestartableError).code).toBe('JOB_NOT_RESTARTABLE');
      expect((err as JobNotRestartableError).details).toEqual({ jobId: 'restart-disabled' });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: launch with restartable: true + no checkpoint → starts from
  // the beginning (same as a fresh launch)
  // -------------------------------------------------------------------------
  test('2) restartable: true + no checkpoint → starts from beginning, all chunks processed', async () => {
    const writer = new RecordingWriter();
    const { launcher, registry, repository } = buildLauncher(
      new ArrayReader([1, 2, 3, 4, 5]),
      writer,
    );
    const jobDef = chunkJobDef('restart-no-checkpoint', { restartable: true });
    registry.register(jobDef);

    const result = await launcher.launch('restart-no-checkpoint', { k: 'v' });

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(writer.chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  // -------------------------------------------------------------------------
  // Test 3: launch with restartable: true + checkpoint of lastChunkIndex=0
  // → resumes from chunk 1 (skips chunk 0, drains the reader past it)
  // -------------------------------------------------------------------------
  test('3) restartable: true + checkpoint lastChunkIndex=0 → skips chunk 0, resumes from chunk 1', async () => {
    const writer = new RecordingWriter();
    // The reader is the same across both runs (first run committed
    // chunk 0 = items 1,2; the second run is given a fresh reader that
    // starts from the same source). The chunk executor will drain the
    // reader `chunkSize` (2) times to advance past the already-committed
    // items, then process chunks 1+ normally.
    const reader = new ArrayReader([1, 2, 3, 4, 5]);
    const { launcher, repository } = buildLauncher(reader, writer);

    // Set up the prior FAILED execution and a FAILED step execution
    // with the checkpoint `lastChunkIndex: 0` saved in its context.
    const { instanceId, executionId } = await makeFailedExecution(repository, 'restart-resume');
    const priorStep = await repository.createStepExecution(executionId, 's1');
    await repository.updateStepExecution(priorStep.id, {
      status: StepStatus.FAILED,
      exitCode: 'FAILED',
      exitMessage: 'prior run failed mid-stream',
      endTime: new Date(),
    });
    await repository.saveExecutionContext(
      { stepExecutionId: priorStep.id },
      { data: { lastChunkIndex: 0 }, version: 0 },
    );

    const jobDef = chunkJobDef('restart-resume', { restartable: true });
    const execution = await repository.getJobExecution(executionId);
    expect(execution).not.toBeNull();

    const result = await launcher.run(execution!, jobDef);

    expect(result.status).toBe(JobStatus.COMPLETED);
    // Chunk 0 (items 1, 2) was already committed in the prior run.
    // The restart processes chunks 1 (items 3, 4) and 2 (item 5).
    // No duplicates — only 3 items written in the restart.
    expect(writer.chunks).toEqual([[3, 4], [5]]);
    // instanceId is unchanged — the run() path reuses the prior instance.
    expect(result.jobInstanceId).toBe(instanceId);
  });

  // -------------------------------------------------------------------------
  // Test 4: After successful completion of a chunk step, `lastChunkIndex`
  // is persisted in the step's ExecutionContext
  // -------------------------------------------------------------------------
  test('4) after successful completion, lastChunkIndex is saved in the step ExecutionContext', async () => {
    const writer = new RecordingWriter();
    const { launcher, registry, repository } = buildLauncher(
      new ArrayReader([1, 2, 3, 4, 5, 6, 7]),
      writer,
    );
    const jobDef = chunkJobDef('restart-checkpoint-write', { restartable: true });
    registry.register(jobDef);

    const result = await launcher.launch('restart-checkpoint-write', {});

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(writer.chunks).toEqual([[1, 2], [3, 4], [5, 6], [7]]);

    // The most recent step execution for `s1` should have its
    // ExecutionContext hold `lastChunkIndex: 3` (the 0-based index of
    // the last committed chunk — 4 chunks total at indices 0, 1, 2, 3).
    const lastStep = await repository.findLatestStepExecution(result.id, 's1');
    expect(lastStep).not.toBeNull();
    const ctx = await repository.getExecutionContext({ stepExecutionId: lastStep!.id });
    expect(ctx.data).toEqual({ lastChunkIndex: 3 });
  });

  test('5) restart copies prior failed step ExecutionContext before stream reader open', async () => {
    const reader = new RestartableArrayReader([1, 2, 3, 4, 5]);
    const writer = new RecordingWriter();
    const repository = new InMemoryJobRepository();
    const transactionManager = new InMemoryTransactionManager();
    const listenerInvoker = new ListenerInvoker();
    const taskletExecutor = new TaskletStepExecutor();
    const chunkExecutor = new ChunkStepExecutor();
    const flowEvaluator = new FlowEvaluator();
    const jobExecutor = new JobExecutor(
      repository,
      transactionManager,
      taskletExecutor,
      chunkExecutor,
      listenerInvoker,
      flowEvaluator,
    );
    const registry = new JobRegistry();
    const launcher = new JobLauncher(registry, repository, jobExecutor);

    const { executionId } = await makeFailedExecution(repository, 'restart-stream-context');
    const priorStep = await repository.createStepExecution(executionId, 's1');
    await repository.updateStepExecution(priorStep.id, {
      status: StepStatus.FAILED,
      exitCode: 'FAILED',
      exitMessage: 'prior run failed after first chunk',
      endTime: new Date(),
    });
    await repository.saveExecutionContext(
      { stepExecutionId: priorStep.id },
      { data: { lastChunkIndex: 0, cursor: 2, custom: 'preserved' }, version: 0 },
    );

    const jobDef: JobDefinition = {
      id: 'restart-stream-context',
      steps: {
        s1: {
          kind: 'chunk',
          id: 's1',
          chunkSize: 2,
          reader: { kind: RefKind.BuilderLambda, fn: () => reader },
          writer: { kind: RefKind.BuilderLambda, fn: () => writer },
          listeners: [],
        },
      },
      startStepId: 's1',
      transitions: [],
      listeners: [],
      restartable: true,
      allowDuplicateInstances: false,
    };
    const execution = await repository.getJobExecution(executionId);
    expect(execution).not.toBeNull();

    const result = await launcher.run(execution!, jobDef);

    expect(result.status).toBe(JobStatus.COMPLETED);
    expect(reader.openContexts).toHaveLength(1);
    expect(reader.openContexts[0]!.data).toEqual({
      lastChunkIndex: 0,
      cursor: 2,
      custom: 'preserved',
    });
    expect(writer.chunks).toEqual([[3, 4], [5]]);

    const newStep = await repository.findLatestStepExecution(result.id, 's1');
    expect(newStep).not.toBeNull();
    const copiedContext = await repository.getExecutionContext({ stepExecutionId: newStep!.id });
    expect(copiedContext.data).toEqual({
      lastChunkIndex: 2,
      cursor: 5,
      custom: 'preserved',
    });
  });
});
