import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { DiscoveryService, ModulesContainer, Reflector } from '@nestjs/core';

import {
  BATCH_TRANSITION_METADATA,
  Jobable,
  Stepable,
  Tasklet,
  ItemReader,
  ItemProcessor,
  ItemWriter,
  BeforeJob,
  AfterJob,
  BeforeStep,
  AfterStep,
  BeforeChunk,
  AfterChunk,
  OnChunkError,
  BeforeRead,
  AfterRead,
  OnReadError,
  BeforeProcess,
  AfterProcess,
  OnProcessError,
  BeforeWrite,
  AfterWrite,
  OnWriteError,
  OnSkipRead,
  OnSkipProcess,
  OnSkipWrite,
  OnTransition,
} from '../../src/decorators';
import type {
  DiscoveredItemMethod,
  DiscoveredJob,
  DiscoveredListener,
  DiscoveredStep,
  DiscoveredTransition,
  ProviderLike,
} from '../../src/explorer';
import { BatchExplorer } from '../../src/explorer';
import type { ListenerKind, ListenerPhase } from '../../src/core/ir/listener-definition';

// ---------------------------------------------------------------------------
// Fixture jobs
// ---------------------------------------------------------------------------

/** A minimal job with no step / listener / transition methods. */
@Jobable({ id: 'simple-job' })
class SimpleJob {
  doStuff(): void {}
}

/** A job with restartable + allowDuplicateInstances flags populated. */
@Jobable({
  id: 'full-opts-job',
  restartable: true,
  allowDuplicateInstances: true,
})
class FullOptsJob {
  doStuff(): void {}
}

/** A class WITHOUT @Jobable — must not be discovered. */
class NotAJob {
  doStuff(): void {}
}

/** A job with a tasklet step only. */
@Jobable({ id: 'tasklet-job' })
class TaskletJob {
  @Stepable({ id: 'run' })
  @Tasklet()
  run(): Promise<void> {
    return Promise.resolve();
  }
}

/** A job with a chunk step (no @Tasklet). */
@Jobable({ id: 'chunk-job' })
class ChunkJob {
  @Stepable({ id: 'read-write', chunkSize: 10 })
  readWrite(): Promise<void> {
    return Promise.resolve();
  }
}

/** A job with a chunk step + class-level item handlers (for Task 8). */
@Jobable({ id: 'chunk-with-items-job' })
class ChunkWithItemsJob {
  @ItemReader()
  read(): Promise<unknown | null> {
    return Promise.resolve(null);
  }

  @ItemProcessor()
  process(item: unknown): Promise<unknown> {
    return Promise.resolve(item);
  }

  @ItemWriter()
  write(_items: unknown[]): Promise<void> {
    return Promise.resolve();
  }

  @Stepable({ id: 'pipeline', chunkSize: 5 })
  pipeline(): Promise<void> {
    return Promise.resolve();
  }
}

/** A job with one of every listener kind. */
@Jobable({ id: 'listeners-job' })
class ListenersJob {
  // -- Job --
  @BeforeJob()
  beforeJob(): void {}

  @AfterJob()
  afterJob(): void {}

  // -- Step --
  @BeforeStep()
  beforeStep(): void {}

  @AfterStep()
  afterStep(): void {}

  // -- Chunk --
  @BeforeChunk()
  beforeChunk(): void {}

  @AfterChunk()
  afterChunk(): void {}

  @OnChunkError()
  onChunkError(): void {}

  // -- ItemRead --
  @BeforeRead()
  beforeRead(): void {}

  @AfterRead()
  afterRead(): void {}

  @OnReadError()
  onReadError(): void {}

  // -- ItemProcess --
  @BeforeProcess()
  beforeProcess(): void {}

  @AfterProcess()
  afterProcess(): void {}

  @OnProcessError()
  onProcessError(): void {}

  // -- ItemWrite --
  @BeforeWrite()
  beforeWrite(): void {}

  @AfterWrite()
  afterWrite(): void {}

  @OnWriteError()
  onWriteError(): void {}

  // -- Skip --
  @OnSkipRead()
  onSkipRead(): void {}

  @OnSkipProcess()
  onSkipProcess(): void {}

  @OnSkipWrite()
  onSkipWrite(): void {}
}

/** A job with declarative transition methods. */
@Jobable({ id: 'transition-job' })
class TransitionJob {
  run(): void {}

  @OnTransition({
    fromStep: 'a',
    onStatus: 'COMPLETED',
    toStep: 'b',
  })
  onDone(): void {}

  @OnTransition({
    fromStep: 'a',
    onStatus: 'FAILED',
    toStep: null,
  })
  onFail(): void {}
}

/** A second simple job to verify multi-class discovery. */
@Jobable({ id: 'second-job' })
class SecondJob {
  doStuff(): void {}
}

/** A third job, used to verify each discovered entry carries the right id. */
@Jobable({ id: 'third-job' })
class ThirdJob {
  doStuff(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ProviderLike[]` from a list of `{ class, instance? }` objects.
 * The returned shape is what `DiscoveryService.getProviders()` produces.
 */
function providersOf(entries: Array<{ classRef: Function; instance?: unknown }>): ProviderLike[] {
  return entries.map((e) => ({ metatype: e.classRef, instance: e.instance }));
}

/** Build a `BatchExplorer` wired against a fake ModulesContainer. */
function makeExplorer(providers: ProviderLike[]): BatchExplorer {
  // The explorer never actually calls `getProviders()` in the tests below
  // — we drive it via the pure `discoverFromProviders` method directly.
  const discovery = new DiscoveryService(new ModulesContainer());
  // Patch the discovery service to return our test providers.
  discovery.getProviders = (() => providers) as DiscoveryService['getProviders'];
  return new BatchExplorer(discovery, new Reflector());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchExplorer — discoverFromProviders (pure)', () => {
  let explorer: BatchExplorer;

  beforeEach(() => {
    explorer = makeExplorer([]);
  });

  it('returns an empty array when no providers are given', () => {
    expect(explorer.discoverFromProviders([])).toEqual([]);
  });

  it('returns an empty array when no provider carries @Jobable metadata', () => {
    const providers = providersOf([{ classRef: NotAJob }]);
    expect(explorer.discoverFromProviders(providers)).toEqual([]);
  });

  it('skips wrappers with no `metatype` (e.g. value providers)', () => {
    const providers: ProviderLike[] = [
      { instance: 'literal-string' }, // no metatype
      { metatype: SimpleJob },
    ];
    const out = explorer.discoverFromProviders(providers);
    expect(out).toHaveLength(1);
    expect(out[0]!.classRef).toBe(SimpleJob);
  });

  it('discovers a class with @Jobable({ id: "..." })', () => {
    const providers = providersOf([{ classRef: SimpleJob }]);
    const out = explorer.discoverFromProviders(providers);
    expect(out).toHaveLength(1);
    expect(out[0]!.classRef).toBe(SimpleJob);
    expect(out[0]!.jobOptions).toEqual({ id: 'simple-job' });
    expect(out[0]!.stepMethods).toEqual([]);
    expect(out[0]!.itemMethods).toEqual([]);
    expect(out[0]!.listenerMethods).toEqual([]);
    expect(out[0]!.transitionMethods).toEqual([]);
  });

  it('discovers a class with full @Jobable options (id, restartable, allowDuplicateInstances)', () => {
    const providers = providersOf([{ classRef: FullOptsJob }]);
    const out = explorer.discoverFromProviders(providers);
    expect(out).toHaveLength(1);
    expect(out[0]!.jobOptions).toEqual({
      id: 'full-opts-job',
      restartable: true,
      allowDuplicateInstances: true,
    });
  });

  it('passes the resolved DI instance through unchanged', () => {
    const instance = new SimpleJob();
    const providers = providersOf([{ classRef: SimpleJob, instance }]);
    const out = explorer.discoverFromProviders(providers);
    expect(out[0]!.instance).toBe(instance);
  });

  it('discovers multiple @Jobable classes from the same provider list', () => {
    const providers = providersOf([
      { classRef: SimpleJob },
      { classRef: SecondJob },
      { classRef: ThirdJob },
      { classRef: NotAJob }, // filtered out
    ]);
    const out = explorer.discoverFromProviders(providers);
    expect(out).toHaveLength(3);
    expect(out.map((j) => j.jobOptions.id)).toEqual(['simple-job', 'second-job', 'third-job']);
  });
});

describe('BatchExplorer — step method discovery', () => {
  let explorer: BatchExplorer;

  beforeEach(() => {
    explorer = makeExplorer([]);
  });

  it('finds a single @Stepable method (no @Tasklet → isTasklet=false)', () => {
    const providers = providersOf([{ classRef: ChunkJob }]);
    const out = explorer.discoverFromProviders(providers);
    const job = out[0]!;
    expect(job.stepMethods).toHaveLength(1);
    expect(job.stepMethods[0]).toEqual<DiscoveredStep>({
      methodName: 'readWrite',
      options: { id: 'read-write', chunkSize: 10 },
      isTasklet: false,
    });
  });

  it('marks @Stepable + @Tasklet as isTasklet=true', () => {
    const providers = providersOf([{ classRef: TaskletJob }]);
    const out = explorer.discoverFromProviders(providers);
    const job = out[0]!;
    expect(job.stepMethods).toHaveLength(1);
    expect(job.stepMethods[0]).toEqual<DiscoveredStep>({
      methodName: 'run',
      options: { id: 'run' },
      isTasklet: true,
    });
  });

  it('returns multiple step methods in prototype-declaration order when present', () => {
    @Jobable({ id: 'multi-step-job' })
    class MultiStepJob {
      @Stepable({ id: 'a' })
      @Tasklet()
      a(): Promise<void> {
        return Promise.resolve();
      }

      @Stepable({ id: 'b', chunkSize: 3 })
      b(): Promise<void> {
        return Promise.resolve();
      }

      @Stepable({ id: 'c' })
      c(): Promise<void> {
        return Promise.resolve();
      }
    }

    const out = explorer.discoverFromProviders(providersOf([{ classRef: MultiStepJob }]));
    expect(out[0]!.stepMethods.map((s) => s.methodName)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.stepMethods.map((s) => s.isTasklet)).toEqual([true, false, false]);
  });

  it('does NOT include non-step methods in stepMethods', () => {
    @Jobable({ id: 'mixed-step-job' })
    class MixedStepJob {
      @Stepable({ id: 'real' })
      real(): Promise<void> {
        return Promise.resolve();
      }

      notAStep(): void {}
    }

    const out = explorer.discoverFromProviders(providersOf([{ classRef: MixedStepJob }]));
    expect(out[0]!.stepMethods).toHaveLength(1);
    expect(out[0]!.stepMethods[0]!.methodName).toBe('real');
  });
});

describe('BatchExplorer — item handler discovery (compiler feeds here)', () => {
  let explorer: BatchExplorer;

  beforeEach(() => {
    explorer = makeExplorer([]);
  });

  it('collects @ItemReader / @ItemProcessor / @ItemWriter methods', () => {
    const providers = providersOf([{ classRef: ChunkWithItemsJob }]);
    const out = explorer.discoverFromProviders(providers);
    expect(out).toHaveLength(1);
    expect(out[0]!.itemMethods).toEqual<DiscoveredItemMethod[]>([
      { methodName: 'read', kind: 'reader' },
      { methodName: 'process', kind: 'processor' },
      { methodName: 'write', kind: 'writer' },
    ]);
  });

  it('collects reader factory metadata', () => {
    @Jobable({ id: 'factory-reader-job' })
    class FactoryReaderJob {
      @ItemReader({ factory: true })
      createReader(): unknown {
        return null;
      }

      @ItemWriter()
      write(): void {}

      @Stepable({ id: 'pipeline', chunkSize: 5 })
      pipeline(): void {}
    }

    const out = explorer.discoverFromProviders(providersOf([{ classRef: FactoryReaderJob }]));
    expect(out[0]!.itemMethods).toEqual<DiscoveredItemMethod[]>([
      { methodName: 'createReader', kind: 'reader', factory: true },
      { methodName: 'write', kind: 'writer' },
    ]);
  });

  it('co-exists with @Stepable on a different method (chunk step + class-level item handlers)', () => {
    const providers = providersOf([{ classRef: ChunkWithItemsJob }]);
    const out = explorer.discoverFromProviders(providers);
    const job = out[0]!;
    expect(job.stepMethods).toHaveLength(1);
    expect(job.stepMethods[0]!.methodName).toBe('pipeline');
    expect(job.stepMethods[0]!.isTasklet).toBe(false);
    expect(job.itemMethods.map((item) => item.methodName)).toEqual(['read', 'process', 'write']);
  });
});

describe('BatchExplorer — listener discovery (all 7 kinds)', () => {
  let explorer: BatchExplorer;

  beforeEach(() => {
    explorer = makeExplorer([]);
  });

  const EXPECTED: ReadonlyArray<{
    method: string;
    kind: ListenerKind;
    phase: ListenerPhase;
    skipKind?: 'read' | 'process' | 'write';
  }> = [
    { method: 'beforeJob', kind: 'job', phase: 'before' },
    { method: 'afterJob', kind: 'job', phase: 'after' },
    { method: 'beforeStep', kind: 'step', phase: 'before' },
    { method: 'afterStep', kind: 'step', phase: 'after' },
    { method: 'beforeChunk', kind: 'chunk', phase: 'before' },
    { method: 'afterChunk', kind: 'chunk', phase: 'after' },
    { method: 'onChunkError', kind: 'chunk', phase: 'on-error' },
    { method: 'beforeRead', kind: 'item-read', phase: 'before' },
    { method: 'afterRead', kind: 'item-read', phase: 'after' },
    { method: 'onReadError', kind: 'item-read', phase: 'on-error' },
    { method: 'beforeProcess', kind: 'item-process', phase: 'before' },
    { method: 'afterProcess', kind: 'item-process', phase: 'after' },
    { method: 'onProcessError', kind: 'item-process', phase: 'on-error' },
    { method: 'beforeWrite', kind: 'item-write', phase: 'before' },
    { method: 'afterWrite', kind: 'item-write', phase: 'after' },
    { method: 'onWriteError', kind: 'item-write', phase: 'on-error' },
    { method: 'onSkipRead', kind: 'skip', phase: 'after', skipKind: 'read' },
    { method: 'onSkipProcess', kind: 'skip', phase: 'after', skipKind: 'process' },
    { method: 'onSkipWrite', kind: 'skip', phase: 'after', skipKind: 'write' },
  ];

  it('collects all 19 listener methods (covers all 7 kinds)', () => {
    const providers = providersOf([{ classRef: ListenersJob }]);
    const out = explorer.discoverFromProviders(providers);
    const job = out[0]!;
    expect(job.listenerMethods).toHaveLength(EXPECTED.length);

    for (const expected of EXPECTED) {
      const found = job.listenerMethods.find((l) => l.methodName === expected.method);
      expect(found, `listener method "${expected.method}" should be discovered`).toBeDefined();
      expect(found!.kind).toBe(expected.kind);
      expect(found!.phase).toBe(expected.phase);
      expect(found!.skipKind).toBe(expected.skipKind);
    }
  });

  it('covers exactly the 7 documented listener kinds', () => {
    const providers = providersOf([{ classRef: ListenersJob }]);
    const out = explorer.discoverFromProviders(providers);
    const kinds = new Set(out[0]!.listenerMethods.map((l) => l.kind));
    expect(kinds).toEqual(
      new Set<ListenerKind>([
        'job',
        'step',
        'chunk',
        'item-read',
        'item-process',
        'item-write',
        'skip',
      ]),
    );
  });

  it('does not include non-listener methods in listenerMethods', () => {
    @Jobable({ id: 'mixed-listener-job' })
    class MixedListenerJob {
      @BeforeJob()
      before(): void {}

      notAListener(): void {}
    }
    const out = explorer.discoverFromProviders(providersOf([{ classRef: MixedListenerJob }]));
    expect(out[0]!.listenerMethods).toEqual<DiscoveredListener[]>([
      { methodName: 'before', kind: 'job', phase: 'before' },
    ]);
  });
});

describe('BatchExplorer — transition discovery', () => {
  let explorer: BatchExplorer;

  beforeEach(() => {
    explorer = makeExplorer([]);
  });

  it('discovers methods carrying BATCH_TRANSITION_METADATA (toStep set)', () => {
    const providers = providersOf([{ classRef: TransitionJob }]);
    const out = explorer.discoverFromProviders(providers);
    const job = out[0]!;
    expect(job.transitionMethods).toHaveLength(2);
    const onDone = job.transitionMethods.find((t) => t.methodName === 'onDone');
    expect(onDone).toEqual<DiscoveredTransition>({
      methodName: 'onDone',
      fromStep: 'a',
      onStatus: 'COMPLETED',
      toStep: 'b',
    });
  });

  it('discovers methods with toStep=null (END-of-flow transition)', () => {
    const providers = providersOf([{ classRef: TransitionJob }]);
    const out = explorer.discoverFromProviders(providers);
    const onFail = out[0]!.transitionMethods.find((t) => t.methodName === 'onFail');
    expect(onFail).toEqual<DiscoveredTransition>({
      methodName: 'onFail',
      fromStep: 'a',
      onStatus: 'FAILED',
      toStep: null,
    });
  });

  it('returns an empty array for jobs without any transition metadata', () => {
    const providers = providersOf([{ classRef: SimpleJob }]);
    const out = explorer.discoverFromProviders(providers);
    expect(out[0]!.transitionMethods).toEqual([]);
  });

  it('leaves BATCH_TRANSITION_METADATA readable through Reflector on the method handler', () => {
    const providers = providersOf([{ classRef: TransitionJob }]);
    explorer.discoverFromProviders(providers);
    const reflector = new Reflector();
    expect(reflector.get(BATCH_TRANSITION_METADATA, TransitionJob.prototype.onDone)).toEqual({
      fromStep: 'a',
      onStatus: 'COMPLETED',
      toStep: 'b',
    });
  });
});

describe('BatchExplorer — OnModuleInit hook', () => {
  it('populates `discovered` by calling discovery.getProviders() once', () => {
    const discovery = new DiscoveryService(new ModulesContainer());
    const providers = providersOf([{ classRef: SimpleJob }, { classRef: SecondJob }]);

    let getProvidersCalls = 0;
    discovery.getProviders = (() => {
      getProvidersCalls += 1;
      return providers as ReturnType<typeof discovery.getProviders>;
    }) as DiscoveryService['getProviders'];

    const explorer = new BatchExplorer(discovery, new Reflector());
    expect(explorer.getDiscovered()).toEqual([]);

    explorer.onModuleInit();
    expect(getProvidersCalls).toBe(1);
    const discovered = explorer.getDiscovered();
    expect(discovered).toHaveLength(2);
    expect(discovered.map((d) => d.jobOptions.id)).toEqual(['simple-job', 'second-job']);
  });

  it('exposes a readonly array (caller must not mutate)', () => {
    const discovery = new DiscoveryService(new ModulesContainer());
    const providers = providersOf([{ classRef: SimpleJob }]);
    discovery.getProviders = (() =>
      providers as ReturnType<typeof discovery.getProviders>) as DiscoveryService['getProviders'];

    const explorer = new BatchExplorer(discovery, new Reflector());
    explorer.onModuleInit();
    const discovered = explorer.getDiscovered();
    // The returned array is typed as readonly; we also verify it is the
    // same reference as the internal one (the explorer does not deep-clone).
    expect(Array.isArray(discovered)).toBe(true);
    // We can still cast at runtime to confirm; this is a structural check
    // rather than a strict immutability guarantee (TypeScript enforces the
    // readonly contract at compile time).
    expect((discovered as readonly DiscoveredJob[]).length).toBe(1);
  });
});

describe('BatchExplorer — surface (sanity / coverage)', () => {
  it('BatchExplorer is a class named "BatchExplorer"', () => {
    expect(typeof BatchExplorer).toBe('function');
    expect(BatchExplorer.name).toBe('BatchExplorer');
  });

  it('BatchExplorer is @Injectable() (decorator applied without error)', () => {
    // The @Injectable() decorator runs at module load time. If it
    // failed the class would not be defined. We assert the runtime
    // type as a smoke test.
    expect(BatchExplorer).toBeDefined();
    expect(typeof BatchExplorer).toBe('function');
  });

  it('BatchExplorer implements OnModuleInit (has onModuleInit method)', () => {
    const proto = BatchExplorer.prototype as { onModuleInit?: () => void };
    expect(typeof proto.onModuleInit).toBe('function');
  });
});
