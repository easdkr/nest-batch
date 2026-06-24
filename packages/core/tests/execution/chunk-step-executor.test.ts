import { describe, expect, test, vi } from 'vitest';
import {
  ChunkStepExecutor,
  type ChunkExecutionContext,
} from '../../src/execution/chunk-step-executor';
import { ListenerInvoker, type ResolverMap } from '../../src/execution/listener-invoker';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { TransactionManager } from '../../src/core/transaction';
import {
  RefKind,
  type ChunkStepDefinition,
  type SkipPolicyConfig,
  type RetryPolicyConfig,
} from '../../src/core/ir';
import type {
  ItemExecutionContext,
  ItemReader,
  ItemProcessor,
  ItemStream,
  ItemWriter,
} from '../../src/core/item';
import type { ExecutionContext, JobParameters } from '../../src/core/repository';
import { StepStatus } from '../../src/core/status';
import { SkipLimitExceededError, RetryLimitExceededError } from '../../src/core/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class SkipError extends Error {
  readonly code = 'SKIP';
  constructor(message = 'skippable') {
    super(message);
  }
}
class RetryableError extends Error {
  readonly code = 'RETRYABLE';
  constructor(message = 'retryable') {
    super(message);
  }
}

/** A simple in-memory reader that yields items one at a time, null at EOF. */
class ArrayReader implements ItemReader<number> {
  private i = 0;
  constructor(private readonly items: number[]) {}
  async read(): Promise<number | null> {
    return this.i < this.items.length ? (this.items[this.i++] as number) : null;
  }
}

/** A reader that throws on the configured 0-based call indices, then
 *  continues with the next item. The internal item index only advances on
 *  successful reads, so a thrown call doesn't "consume" an item. */
class FlakyReader implements ItemReader<number> {
  public callCount = 0;
  private i = 0;
  constructor(
    private readonly items: number[],
    private readonly throwOnCalls: ReadonlySet<number> = new Set(),
    private readonly error: Error = new Error('flaky'),
  ) {}
  async read(): Promise<number | null> {
    const n = this.callCount++;
    if (this.throwOnCalls.has(n)) throw this.error;
    if (this.i >= this.items.length) return null;
    return this.items[this.i++] as number;
  }
}

/** A reader that throws on every call (for retry-exhaustion tests). */
class AlwaysThrowingReader implements ItemReader<number> {
  public callCount = 0;
  constructor(private readonly error: Error) {}
  async read(): Promise<number | null> {
    this.callCount += 1;
    throw this.error;
  }
}

/** A processor that doubles each item, optionally returning null for the configured indices. */
class MultiplyProcessor implements ItemProcessor<number, number> {
  constructor(private readonly nullFor: ReadonlySet<number> = new Set()) {}
  async process(item: number): Promise<number | null> {
    if (this.nullFor.has(item)) return null;
    return item * 2;
  }
}

/** A processor that throws on a configurable set of items, then succeeds. */
class ThrowingProcessor implements ItemProcessor<number, number> {
  public callCount = 0;
  constructor(
    private readonly throwOnItems: ReadonlySet<number> = new Set(),
    private readonly error: Error = new Error('process fail'),
  ) {}
  async process(item: number): Promise<number | null> {
    this.callCount += 1;
    if (this.throwOnItems.has(item)) throw this.error;
    return item * 2;
  }
}

/** A writer that records every chunk it receives. */
class RecordingWriter implements ItemWriter<number> {
  public readonly chunks: number[][] = [];
  /** If set, the next write() call rejects with this error. */
  public failWith: unknown = null;
  async write(items: number[]): Promise<void> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    this.chunks.push([...items]);
  }
}

class StreamArrayReader implements ItemReader<number>, ItemStream {
  private i = 0;
  public updateCount = 0;
  constructor(
    private readonly items: number[],
    private readonly events: string[],
  ) {}
  async open(_context: ExecutionContext): Promise<void> {
    this.events.push('reader.open');
  }
  async read(): Promise<number | null> {
    return this.i < this.items.length ? (this.items[this.i++] as number) : null;
  }
  async update(context: ExecutionContext): Promise<ExecutionContext> {
    this.updateCount += 1;
    this.events.push(`reader.update.${this.updateCount}`);
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    return {
      ...context,
      data: {
        ...data,
        readerUpdateCount: this.updateCount,
      },
    };
  }
  async close(): Promise<void> {
    this.events.push('reader.close');
  }
}

class StreamRecordingWriter implements ItemWriter<number>, ItemStream {
  public readonly chunks: number[][] = [];
  public updateCount = 0;
  constructor(private readonly events: string[]) {}
  async open(_context: ExecutionContext): Promise<void> {
    this.events.push('writer.open');
  }
  async write(items: number[]): Promise<void> {
    this.chunks.push([...items]);
  }
  async update(context: ExecutionContext): Promise<ExecutionContext> {
    this.updateCount += 1;
    this.events.push(`writer.update.${this.updateCount}`);
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    return {
      ...context,
      data: {
        ...data,
        writerUpdateCount: this.updateCount,
      },
    };
  }
  async close(): Promise<void> {
    this.events.push('writer.close');
  }
}

/** A writer that throws the first N times, then succeeds. */
class FlakyWriter implements ItemWriter<number> {
  public callCount = 0;
  public readonly chunks: number[][] = [];
  constructor(
    private readonly failTimes: number,
    private readonly error: Error = new Error('flaky write'),
  ) {}
  async write(items: number[]): Promise<void> {
    this.callCount += 1;
    if (this.callCount <= this.failTimes) throw this.error;
    this.chunks.push([...items]);
  }
}

/** A writer that always throws (for retry/skip-exhaustion tests). */
class AlwaysThrowingWriter implements ItemWriter<number> {
  public callCount = 0;
  constructor(private readonly error: Error) {}
  async write(_items: number[]): Promise<void> {
    this.callCount += 1;
    throw this.error;
  }
}

/** TransactionManager that counts how many times `withTransaction` is invoked. */
class TrackingTransactionManager extends TransactionManager {
  public callCount = 0;
  async withTransaction<T>(fn: (ctx: { isActive: true; id: string }) => Promise<T>): Promise<T> {
    this.callCount += 1;
    return fn({ isActive: true, id: `tx-${this.callCount}` });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ChunkExecutionContext with a populated resolver map. */
function buildContext(opts: {
  reader: ItemReader<number>;
  processor?: ItemProcessor<number, number>;
  writer: ItemWriter<number>;
  jobExecutionId2?: string;
  jobParameters?: JobParameters;
  listenerResolvers?: ResolverMap;
  transactionManager?: TransactionManager;
  skipListenerResolvers?: ResolverMap;
}): ChunkExecutionContext {
  const resolvers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
  // Cast bound methods to the Map value type — strict variance (`number[]` →
  // `unknown[]` is contravariant) is intentional here since the test only
  // wires the methods to the executor's resolver map contract.
  if (opts.reader) {
    resolvers.set(
      'test::reader::Reader::read',
      opts.reader.read.bind(opts.reader) as (...args: unknown[]) => unknown | Promise<unknown>,
    );
  }
  if (opts.processor) {
    resolvers.set(
      'test::processor::Processor::process',
      opts.processor.process.bind(opts.processor) as (
        ...args: unknown[]
      ) => unknown | Promise<unknown>,
    );
  }
  if (opts.writer) {
    resolvers.set(
      'test::writer::Writer::write',
      opts.writer.write.bind(opts.writer) as (...args: unknown[]) => unknown | Promise<unknown>,
    );
  }
  return {
    jobExecutionId: 'job-1',
    stepExecutionId: 'step-1',
    jobRepository: new InMemoryJobRepository(),
    transactionManager: opts.transactionManager ?? new InMemoryTransactionManager(),
    listenerInvoker: new ListenerInvoker(),
    ...(opts.jobParameters ? { jobParameters: opts.jobParameters } : {}),
    ...(opts.listenerResolvers ? { listenerResolvers: opts.listenerResolvers } : {}),
    resolvers,
    jobExecutionId2: opts.jobExecutionId2 ?? 'test',
    ...(opts.skipListenerResolvers ? { skipListenerResolvers: opts.skipListenerResolvers } : {}),
  };
}

function chunkStep(opts: {
  chunkSize: number;
  processor?: ChunkStepDefinition['processor'];
  skipPolicy?: SkipPolicyConfig;
  retryPolicy?: RetryPolicyConfig;
}): ChunkStepDefinition {
  return {
    kind: 'chunk',
    id: 'step-1',
    chunkSize: opts.chunkSize,
    reader: { kind: RefKind.Method, classToken: 'Reader', methodName: 'read' },
    processor: opts.processor ?? {
      kind: RefKind.Method,
      classToken: 'Processor',
      methodName: 'process',
    },
    writer: { kind: RefKind.Method, classToken: 'Writer', methodName: 'write' },
    listeners: [],
    ...(opts.skipPolicy ? { skipPolicy: opts.skipPolicy } : {}),
    ...(opts.retryPolicy ? { retryPolicy: opts.retryPolicy } : {}),
  };
}

describe('ChunkStepExecutor', () => {
  test('5 items, chunkSize=2 → 3 chunks, readCount=5, writeCount=5, commitCount=3', async () => {
    const reader = new ArrayReader([1, 2, 3, 4, 5]);
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({
      chunkSize: 2,
      processor: { kind: RefKind.Method, classToken: 'Processor', methodName: 'process' },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    expect(result.readCount).toBe(5);
    expect(result.writeCount).toBe(5);
    expect(result.commitCount).toBe(3); // ceil(5/2) = 3 chunks
    expect(result.skipCount).toBe(0);
    expect(writer.chunks).toEqual([
      [2, 4], // chunk 1: 1*2, 2*2
      [6, 8], // chunk 2: 3*2, 4*2
      [10], // chunk 3: 5*2
    ]);
  });

  test('stream-capable reader and writer receive open/update/close hooks', async () => {
    const events: string[] = [];
    const reader = new StreamArrayReader([1, 2, 3], events);
    const writer = new StreamRecordingWriter(events);
    const repository = new InMemoryJobRepository();
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'stream-step',
      chunkSize: 2,
      reader: { kind: RefKind.BuilderLambda, fn: () => reader },
      writer: { kind: RefKind.BuilderLambda, fn: () => writer },
      listeners: [],
    };
    const ctx: ChunkExecutionContext = {
      ...buildContext({ reader, writer }),
      stepExecutionId: 'stream-step-execution',
      jobRepository: repository,
    };

    const result = await new ChunkStepExecutor().execute(step, ctx);
    const persisted = await repository.getExecutionContext({
      stepExecutionId: 'stream-step-execution',
    });

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.commitCount).toBe(2);
    expect(writer.chunks).toEqual([[1, 2], [3]]);
    expect(events).toEqual([
      'reader.open',
      'writer.open',
      'reader.update.1',
      'writer.update.1',
      'reader.update.2',
      'writer.update.2',
      'writer.close',
      'reader.close',
    ]);
    expect(persisted.data).toEqual({
      lastChunkIndex: 1,
      readerUpdateCount: 2,
      writerUpdateCount: 2,
    });
  });

  test('empty reader → 0 reads, 0 writes, status COMPLETED, commitCount=0', async () => {
    const reader = new ArrayReader([]);
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({ chunkSize: 2 });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    expect(result.readCount).toBe(0);
    expect(result.writeCount).toBe(0);
    expect(result.commitCount).toBe(0);
    expect(result.skipCount).toBe(0);
    expect(writer.chunks).toEqual([]);
  });

  test('processor returns null for 1 of 3 items → writeCount=2, skipCount=1', async () => {
    const reader = new ArrayReader([1, 2, 3]);
    const processor = new MultiplyProcessor(new Set([2])); // filter out 2
    const writer = new RecordingWriter();

    const step = chunkStep({ chunkSize: 10 }); // single chunk (3 < 10)
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(2); // 3 read, 1 filtered, 2 written
    expect(result.skipCount).toBe(1);
    expect(result.commitCount).toBe(1);
    expect(writer.chunks).toEqual([[2, 6]]); // 1*2, 2 (filtered), 3*2
  });

  test('writer throws → status FAILED, exitMessage carries the error', async () => {
    const reader = new ArrayReader([1, 2, 3]);
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();
    writer.failWith = new Error('disk full');

    const step = chunkStep({ chunkSize: 2 });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toBe('disk full');
    // We read 2 (chunk 1) and tried to write — caught on first chunk.
    // readCount includes the 2 items we read before the failure.
    expect(result.readCount).toBe(2);
    expect(result.writeCount).toBe(0);
    expect(result.commitCount).toBe(0);
  });

  test('reader throws mid-chunk → status FAILED, exitMessage carries the error', async () => {
    class ThrowingReader implements ItemReader<number> {
      private i = 0;
      async read(): Promise<number | null> {
        this.i += 1;
        if (this.i === 2) throw new Error('network down');
        return this.i;
      }
    }

    const reader = new ThrowingReader();
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({ chunkSize: 10 });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toBe('network down');
    expect(result.readCount).toBe(1); // we successfully read 1 item before the throw
    expect(result.writeCount).toBe(0);
    expect(result.commitCount).toBe(0);
  });

  test('no processor (passthrough) — items pass through verbatim', async () => {
    const reader = new ArrayReader([10, 20, 30]);
    const writer = new RecordingWriter();

    // Build a chunk step WITHOUT a processor
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'step-passthrough',
      chunkSize: 2,
      reader: { kind: RefKind.Method, classToken: 'Reader', methodName: 'read' },
      writer: { kind: RefKind.Method, classToken: 'Writer', methodName: 'write' },
      listeners: [],
    };

    // No processor in the resolver map
    const resolvers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
    resolvers.set(
      'test::reader::Reader::read',
      reader.read.bind(reader) as (...args: unknown[]) => unknown | Promise<unknown>,
    );
    resolvers.set(
      'test::writer::Writer::write',
      writer.write.bind(writer) as (...args: unknown[]) => unknown | Promise<unknown>,
    );
    const ctx: ChunkExecutionContext = {
      jobExecutionId: 'job-1',
      stepExecutionId: 'step-passthrough',
      jobRepository: new InMemoryJobRepository(),
      transactionManager: new InMemoryTransactionManager(),
      listenerInvoker: new ListenerInvoker(),
      resolvers,
      jobExecutionId2: 'test',
    };

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(3);
    expect(result.commitCount).toBe(2); // [10,20] + [30]
    expect(writer.chunks).toEqual([[10, 20], [30]]);
  });

  test('chunkSize=10 with 3 items → 1 chunk (3 < 10), commitCount=1', async () => {
    const reader = new ArrayReader([1, 2, 3]);
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({ chunkSize: 10 });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(3);
    expect(result.commitCount).toBe(1);
    expect(writer.chunks).toEqual([[2, 4, 6]]);
  });

  test('processor filters ALL items (returns null) → writeCount=0, commitCount=1 (chunk still committed)', async () => {
    const reader = new ArrayReader([1, 2, 3]);
    const processor = new MultiplyProcessor(new Set([1, 2, 3])); // filter all
    const writer = new RecordingWriter();

    const step = chunkStep({ chunkSize: 10 });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(0);
    expect(result.skipCount).toBe(3);
    expect(result.commitCount).toBe(1); // chunk is still committed (a no-op write)
    expect(writer.chunks).toEqual([]); // writer.write never called when processed is empty
  });

  test('reader/processor/writer receive ItemExecutionContext with jobParameters', async () => {
    const seen: Array<{
      phase: string;
      file: unknown;
      stepExecutionId: string;
      stepName?: string;
    }> = [];

    class ContextReader implements ItemReader<number> {
      private i = 0;
      async read(ctx?: ItemExecutionContext): Promise<number | null> {
        seen.push({
          phase: 'read',
          file: ctx?.jobParameters?.file,
          stepExecutionId: ctx?.stepExecutionId ?? '<missing>',
          stepName: ctx?.stepName,
        });
        if (this.i > 0) return null;
        this.i += 1;
        return 3;
      }
    }

    class ContextProcessor implements ItemProcessor<number, number> {
      async process(item: number, ctx?: ItemExecutionContext): Promise<number> {
        seen.push({
          phase: 'process',
          file: ctx?.jobParameters?.file,
          stepExecutionId: ctx?.stepExecutionId ?? '<missing>',
          stepName: ctx?.stepName,
        });
        return item * 2;
      }
    }

    class ContextWriter implements ItemWriter<number> {
      async write(items: number[], ctx?: ItemExecutionContext): Promise<void> {
        seen.push({
          phase: `write:${items.join(',')}`,
          file: ctx?.jobParameters?.file,
          stepExecutionId: ctx?.stepExecutionId ?? '<missing>',
          stepName: ctx?.stepName,
        });
      }
    }

    const reader = new ContextReader();
    const processor = new ContextProcessor();
    const writer = new ContextWriter();
    const step = chunkStep({ chunkSize: 1 });
    const ctx = buildContext({
      reader,
      processor,
      writer,
      jobParameters: { file: 'launch-param.csv' },
    });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(seen).toEqual([
      {
        phase: 'read',
        file: 'launch-param.csv',
        stepExecutionId: 'step-1',
        stepName: 'step-1',
      },
      {
        phase: 'process',
        file: 'launch-param.csv',
        stepExecutionId: 'step-1',
        stepName: 'step-1',
      },
      {
        phase: 'write:6',
        file: 'launch-param.csv',
        stepExecutionId: 'step-1',
        stepName: 'step-1',
      },
      {
        phase: 'read',
        file: 'launch-param.csv',
        stepExecutionId: 'step-1',
        stepName: 'step-1',
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Skip / retry integration
  // -------------------------------------------------------------------------

  test('SKIP: read throws SkipError for one item → skipCount++, rest processed', async () => {
    const reader = new FlakyReader([1, 2, 3], new Set([1]), new SkipError('skip me'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({
      chunkSize: 10,
      skipPolicy: { limit: 5, skippable: [SkipError] },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.skipCount).toBe(1);
    expect(result.writeCount).toBe(3);
    expect(result.commitCount).toBe(1);
    expect(writer.chunks).toEqual([[2, 4, 6]]);
    expect(reader.callCount).toBe(6); // 1 OK + 1 throw + 2 OK + 1 EOF + 1 final-EOF
  });

  test('SKIP LIMIT: read throws SkipError 3 times with limit=2 → SkipLimitExceededError', async () => {
    const reader = new AlwaysThrowingReader(new SkipError('always skip'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({
      chunkSize: 10,
      skipPolicy: { limit: 2, skippable: [SkipError] },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toMatch(/Skip limit/i);
    expect(reader.callCount).toBe(3); // 2 skipped + 1 throws SkipLimitExceededError
  });

  test('RETRY: read throws once then succeeds → retry happens, items processed', async () => {
    const reader = new FlakyReader([1, 2, 3], new Set([0]), new RetryableError('transient'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({
      chunkSize: 10,
      retryPolicy: { limit: 3, retryable: [RetryableError], backoff: { type: 'none' } },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(3);
    expect(result.commitCount).toBe(1);
    expect(reader.callCount).toBe(6); // 1 throw + 1 retry + 2 OK + 1 EOF + 1 final-EOF
    expect(writer.chunks).toEqual([[2, 4, 6]]);
  });

  test('RETRY LIMIT: read always throws RetryableError with limit=2 → RetryLimitExceededError', async () => {
    const reader = new AlwaysThrowingReader(new RetryableError('persistent'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const step = chunkStep({
      chunkSize: 10,
      retryPolicy: { limit: 2, retryable: [RetryableError], backoff: { type: 'none' } },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toMatch(/Retry limit/i);
    expect(reader.callCount).toBe(3);
  });

  test('WRITE RETRY: writer throws on first call, succeeds on retry → writeCount=3, callCount=2', async () => {
    const reader = new ArrayReader([1, 2, 3]);
    const processor = new MultiplyProcessor();
    const writer = new FlakyWriter(1, new RetryableError('disk hiccup'));

    const step = chunkStep({
      chunkSize: 10,
      retryPolicy: { limit: 3, retryable: [RetryableError], backoff: { type: 'none' } },
    });
    const ctx = buildContext({ reader, processor, writer });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(3);
    expect(result.commitCount).toBe(1);
    expect(writer.callCount).toBe(2); // 1 throw + 1 success
    expect(writer.chunks).toEqual([[2, 4, 6]]);
  });

  test('SKIP LISTENER: read throws SkipError → on-skip:read listener invoked once per skip', async () => {
    const reader = new FlakyReader([1, 2, 3], new Set([0, 1]), new SkipError('skip me'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();

    const skipListener = vi.fn();
    const skipListenerResolvers: ResolverMap = new Map([
      ['on-skip:read:tracker', { fn: skipListener }],
    ]);

    const step = chunkStep({
      chunkSize: 10,
      skipPolicy: { limit: 5, skippable: [SkipError] },
    });
    const ctx = buildContext({ reader, processor, writer, skipListenerResolvers });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.skipCount).toBe(2);
    expect(skipListener).toHaveBeenCalledTimes(2);
    expect(skipListener).toHaveBeenNthCalledWith(1, expect.any(SkipError), null);
    expect(skipListener).toHaveBeenNthCalledWith(2, expect.any(SkipError), null);
  });

  test('READ RETRY LISTENERS: before/error fire per attempt, after fires only on success', async () => {
    const reader = new FlakyReader([1], new Set([0]), new RetryableError('transient'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();
    const events: string[] = [];
    const listenerResolvers: ResolverMap = new Map([
      ['before:item-read:tracker', { fn: () => void events.push('before-read') }],
      ['after:item-read:tracker', { fn: (item: number) => void events.push(`after-read:${item}`) }],
      ['on-error:item-read:tracker', { fn: () => void events.push('read-error') }],
    ]);

    const step = chunkStep({
      chunkSize: 1,
      retryPolicy: { limit: 2, retryable: [RetryableError], backoff: { type: 'none' } },
    });
    const ctx = buildContext({ reader, processor, writer, listenerResolvers });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(events).toEqual([
      'before-read',
      'read-error',
      'before-read',
      'after-read:1',
      'before-read',
    ]);
  });

  test('READ SKIP LISTENERS: skip listener fires only after skip policy accepts the skip', async () => {
    const reader = new FlakyReader([], new Set([0]), new SkipError('skip once'));
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();
    const events: string[] = [];
    const listenerResolvers: ResolverMap = new Map([
      ['before:item-read:tracker', { fn: () => void events.push('before-read') }],
      ['after:item-read:tracker', { fn: () => void events.push('after-read') }],
      ['on-error:item-read:tracker', { fn: () => void events.push('read-error') }],
      ['on-skip:read:tracker', { fn: () => void events.push('skip-read') }],
    ]);

    const step = chunkStep({
      chunkSize: 2,
      skipPolicy: { limit: 1, skippable: [SkipError] },
    });
    const ctx = buildContext({ reader, processor, writer, listenerResolvers });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.skipCount).toBe(1);
    expect(events).toEqual(['before-read', 'read-error', 'skip-read', 'before-read']);
  });

  test('TX WRAP: write phase wraps writer.write in transactionManager.withTransaction once per chunk (chunk-level atomicity)', async () => {
    const reader = new ArrayReader([1, 2, 3, 4, 5, 6, 7]);
    const processor = new MultiplyProcessor();
    const writer = new RecordingWriter();
    const txManager = new TrackingTransactionManager();

    const step = chunkStep({ chunkSize: 2 });
    const ctx = buildContext({ reader, processor, writer, transactionManager: txManager });

    const result = await new ChunkStepExecutor().execute(step, ctx);

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.readCount).toBe(7);
    expect(result.writeCount).toBe(7);
    expect(result.commitCount).toBe(4); // ceil(7/2) = 4 chunks
    // Chunk-level atomicity: the write phase is wrapped in a single
    // transaction per chunk. The writer may then use per-row savepoints
    // (via em.transactional) to allow partial skip without rolling back
    // the entire chunk.
    expect(txManager.callCount).toBe(4);
    expect(writer.chunks.length).toBe(4);
  });
});
