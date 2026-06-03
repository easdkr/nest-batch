import 'reflect-metadata';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import {
  ChunkStepExecutor,
  type ChunkExecutionContext,
} from '../../src/execution/chunk-step-executor';
import {
  TaskletStepExecutor,
  type TaskletExecutionContext,
} from '../../src/execution/tasklet-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { RefKind } from '../../src/core/ir/refs';
import type {
  ChunkStepDefinition,
  TaskletStepDefinition,
} from '../../src/core/ir';
import { StepStatus } from '../../src/core/status';
import type { ItemReader, ItemProcessor, ItemWriter } from '../../src/core/item';

// ---------------------------------------------------------------------------
// Provider tokens
// ---------------------------------------------------------------------------
//
// The IR stores `RefKind.ProviderToken.token` as a `string` (see
// `core/ir/refs.ts`). The Task 9 resolver will look up the matching
// provider instance from the Nest DI container (or an equivalent
// provider-resolver map) using this string as the key.
//
// Nest's `InjectionToken` is also a valid lookup key; the existing IR
// uses a plain string, so the tests use the same shape. The resolver
// is free to accept either; the public IR contract is the string.

const READER_TOKEN = 'PROVIDER_TOKEN_TEST_READER';
const PROCESSOR_TOKEN = 'PROVIDER_TOKEN_TEST_PROCESSOR';
const WRITER_TOKEN = 'PROVIDER_TOKEN_TEST_WRITER';
const TASKLET_TOKEN = 'PROVIDER_TOKEN_TEST_TASKLET';
const LISTENER_TOKEN = 'PROVIDER_TOKEN_TEST_LISTENER';
const MISSING_TOKEN = 'PROVIDER_TOKEN_NOT_BOUND';

// ---------------------------------------------------------------------------
// Singleton-scoped provider implementations (Nest's default scope)
//
// The resolver contract is that the provider instance resolved from
// the DI container is reused for the entire run. Request-scoped
// providers are out of scope for this task (the gap is documented but
// not closed here).
// ---------------------------------------------------------------------------

class ArrayReader implements ItemReader<number> {
  public callCount = 0;
  private i = 0;
  constructor(private readonly items: number[]) {}
  async read(): Promise<number | null> {
    this.callCount += 1;
    return this.i < this.items.length ? (this.items[this.i++] as number) : null;
  }
}

class MultiplyProcessor implements ItemProcessor<number, number> {
  public callCount = 0;
  async process(item: number): Promise<number> {
    this.callCount += 1;
    return item * 2;
  }
}

class RecordingWriter implements ItemWriter<number> {
  public callCount = 0;
  public readonly chunks: number[][] = [];
  async write(items: number[]): Promise<void> {
    this.callCount += 1;
    this.chunks.push([...items]);
  }
}

class SimpleTasklet {
  public callCount = 0;
  async execute(): Promise<string> {
    this.callCount += 1;
    return 'OK';
  }
}

class SpyListenerProvider {
  public callCount = 0;
  onListener(): void {
    this.callCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RefKind.ProviderToken ref resolution (RED — Task 9 pending)', () => {
  let moduleRef: TestingModule;
  let reader: ArrayReader;
  let processor: MultiplyProcessor;
  let writer: RecordingWriter;
  let taskletInstance: SimpleTasklet;
  let listenerProvider: SpyListenerProvider;

  beforeEach(async () => {
    reader = new ArrayReader([1, 2, 3]);
    processor = new MultiplyProcessor();
    writer = new RecordingWriter();
    taskletInstance = new SimpleTasklet();
    listenerProvider = new SpyListenerProvider();

    // Build a Nest testing module with singleton providers bound to
    // string tokens. Task 9's resolver looks up these instances by
    // token from the DI container. Asserting the providers' spy
    // methods were called proves the resolver wired the right
    // instance into the executor.
    moduleRef = await Test.createTestingModule({
      providers: [
        { provide: READER_TOKEN, useValue: reader },
        { provide: PROCESSOR_TOKEN, useValue: processor },
        { provide: WRITER_TOKEN, useValue: writer },
        { provide: TASKLET_TOKEN, useValue: taskletInstance },
        { provide: LISTENER_TOKEN, useValue: listenerProvider },
      ],
    }).compile();
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  /**
   * Build a `ChunkExecutionContext` wired to the providers resolved
   * from the Nest testing module.
   *
   * The `providerResolvers` field is the entry point Task 9 introduces.
   * We cast the context to `any` to add it; the executor's resolver
   * methods today throw "Unsupported <kind> ref kind: provider-token"
   * before they ever consult this map.
   *
   * Once Task 9 lands, the resolver will use this map (or a Nest
   * `ModuleRef`) to resolve each `ProviderToken` ref to the matching
   * singleton instance, and the assertions below will pass.
   *
   * NOTE: the listener-resolution path is exercised separately by
   * Task 8 (listener resolver wiring). The chunk/tasklet executors
   * do not iterate over `step.listeners`; that resolution lives
   * upstream in the JobExecutor's resolver-map build, which is why
   * it is intentionally out of scope for this file.
   */
  function buildChunkContext(): ChunkExecutionContext {
    const ctx: ChunkExecutionContext = {
      jobExecutionId: 'job-1',
      stepExecutionId: 'step-1',
      jobRepository: new InMemoryJobRepository(),
      transactionManager: new InMemoryTransactionManager(),
      listenerInvoker: new ListenerInvoker(),
      resolvers: new Map(),
      jobExecutionId2: 'test',
    };
    // Cast to add the new field Task 9 will introduce on the
    // context. The runtime reads the field; today the resolver
    // methods throw before ever consulting it.
    (ctx as unknown as { providerResolvers: Map<string, unknown> }).providerResolvers =
      new Map<string, unknown>([
        [READER_TOKEN, reader],
        [PROCESSOR_TOKEN, processor],
        [WRITER_TOKEN, writer],
      ]);
    return ctx;
  }

  function buildTaskletContext(): TaskletExecutionContext {
    const ctx: TaskletExecutionContext = {
      jobExecutionId: 'job-1',
      jobRepository: new InMemoryJobRepository(),
      transactionManager: new InMemoryTransactionManager(),
      listenerInvoker: new ListenerInvoker(),
      listenerResolvers: new Map(),
    };
    (ctx as unknown as { providerResolvers: Map<string, unknown> }).providerResolvers =
      new Map<string, unknown>([[TASKLET_TOKEN, taskletInstance]]);
    return ctx;
  }

  // -------------------------------------------------------------------------
  // POSITIVE — provider methods are invoked
  // -------------------------------------------------------------------------

  test('ReaderRef{ProviderToken} resolves to the bound provider — read() is invoked', async () => {
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'chunk-reader',
      chunkSize: 10,
      reader: { kind: RefKind.ProviderToken, token: READER_TOKEN },
      processor: { kind: RefKind.ProviderToken, token: PROCESSOR_TOKEN },
      writer: { kind: RefKind.ProviderToken, token: WRITER_TOKEN },
      listeners: [],
    };

    const result = await new ChunkStepExecutor().execute(step, buildChunkContext());

    // After Task 9 lands, the resolver looks up each ProviderToken
    // by string against the provider-resolver map. Each method
    // fires and the chunk step completes with the expected counts.
    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(3);
    expect(reader.callCount).toBeGreaterThan(0);
  });

  test('ProcessorRef{ProviderToken} resolves to the bound provider — process() is invoked', async () => {
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'chunk-processor',
      chunkSize: 10,
      reader: { kind: RefKind.ProviderToken, token: READER_TOKEN },
      processor: { kind: RefKind.ProviderToken, token: PROCESSOR_TOKEN },
      writer: { kind: RefKind.ProviderToken, token: WRITER_TOKEN },
      listeners: [],
    };

    await new ChunkStepExecutor().execute(step, buildChunkContext());

    // 3 items × 1 process call each = 3 invocations.
    expect(processor.callCount).toBe(3);
  });

  test('WriterRef{ProviderToken} resolves to the bound provider — write() is invoked', async () => {
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'chunk-writer',
      chunkSize: 10,
      reader: { kind: RefKind.ProviderToken, token: READER_TOKEN },
      processor: { kind: RefKind.ProviderToken, token: PROCESSOR_TOKEN },
      writer: { kind: RefKind.ProviderToken, token: WRITER_TOKEN },
      listeners: [],
    };

    await new ChunkStepExecutor().execute(step, buildChunkContext());

    // 3 items in a single 10-item chunk → 1 write call.
    expect(writer.callCount).toBe(1);
    expect(writer.chunks).toEqual([[2, 4, 6]]);
  });

  test('TaskletRef{ProviderToken} resolves to the bound provider — execute() is invoked', async () => {
    const step: TaskletStepDefinition = {
      kind: 'tasklet',
      id: 'tasklet-step',
      tasklet: { kind: RefKind.ProviderToken, token: TASKLET_TOKEN },
      listeners: [],
    };

    const result = await new TaskletStepExecutor().execute(step, buildTaskletContext());

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.exitCode).toBe('COMPLETED');
    expect(result.exitMessage).toBe('OK');
    expect(taskletInstance.callCount).toBe(1);
  });

  test('singleton provider instance is reused across the whole run', async () => {
    // The resolver must return the same singleton instance each time
    // the ref is resolved. If a new instance were created per chunk,
    // callCount would not accumulate across chunks. Nest's default
    // scope is singleton; request-scoped providers are explicitly
    // out of scope for this test (documented gap, not closed here).
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'chunk-singleton',
      chunkSize: 1, // 1-item chunks → 3 chunks, 3 writer calls
      reader: { kind: RefKind.ProviderToken, token: READER_TOKEN },
      processor: { kind: RefKind.ProviderToken, token: PROCESSOR_TOKEN },
      writer: { kind: RefKind.ProviderToken, token: WRITER_TOKEN },
      listeners: [],
    };

    const result = await new ChunkStepExecutor().execute(step, buildChunkContext());

    expect(result.status).toBe(StepStatus.COMPLETED);
    expect(result.commitCount).toBe(3);
    // The same writer instance handles all 3 chunks — so the
    // callCount accumulator is 3. If a new instance were created
    // per chunk, each instance would have callCount === 1 and the
    // assertion would fail (the original writer would still report
    // only the calls routed through the first chunk's instance).
    expect(writer.callCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE — missing token yields a deterministic error
  // -------------------------------------------------------------------------

  test('missing provider token yields a deterministic error containing the token id', async () => {
    // The reader's token has NO matching provider in the module.
    const step: ChunkStepDefinition = {
      kind: 'chunk',
      id: 'chunk-missing',
      chunkSize: 10,
      reader: { kind: RefKind.ProviderToken, token: MISSING_TOKEN },
      processor: { kind: RefKind.ProviderToken, token: PROCESSOR_TOKEN },
      writer: { kind: RefKind.ProviderToken, token: WRITER_TOKEN },
      listeners: [],
    };

    // The chunk executor surfaces the resolution failure as a
    // FAILED result with the error message in `exitMessage`. The
    // contract is that the error message contains the token id so
    // users can identify the missing provider.
    const result = await new ChunkStepExecutor().execute(step, buildChunkContext());

    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.exitCode).toBe('FAILED');
    expect(result.exitMessage).toContain(MISSING_TOKEN);
  });
});
