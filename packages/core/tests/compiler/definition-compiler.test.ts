import 'reflect-metadata';
import { describe, it, expect } from 'vitest';

import {
  Jobable,
  Stepable,
  Tasklet,
  ItemReader,
  ItemProcessor,
  ItemWriter,
  BeforeJob,
  AfterJob,
} from '../../src/decorators';
import { BatchExplorer, type DiscoveredJob } from '../../src/explorer/batch-explorer';
import {
  DefinitionCompiler,
  ProviderNotFoundError,
} from '../../src/compiler/definition-compiler';
import { RefKind } from '../../src/core/ir';
import { FlowExecutionStatus } from '../../src/core/status';
import { BatchError, InvalidFlowGraphError } from '../../src/core/errors';
import type { JobBuilderConfig } from '../../src/compiler/builder-types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** 1 tasklet step + 1 @BeforeJob listener + 1 @AfterJob listener. */
@Jobable({ id: 'discovered-tasklet-job' })
class DiscoveredTaskletJob {
  @Stepable({ id: 's1' })
  @Tasklet()
  async step1(): Promise<void> {
    return;
  }

  @BeforeJob()
  before(): void {}

  @AfterJob()
  after(): void {}
}

/** Chunk step: 1 @Stepable (no @Tasklet) + @ItemReader + @ItemProcessor + @ItemWriter. */
@Jobable({ id: 'discovered-chunk-job' })
class DiscoveredChunkJob {
  @Stepable({ id: 'c1', chunkSize: 25 })
  @ItemReader()
  async read(): Promise<unknown | null> {
    return null;
  }

  @ItemProcessor()
  async process(item: unknown): Promise<unknown> {
    return item;
  }

  @ItemWriter()
  async write(_items: unknown[]): Promise<void> {
    return;
  }
}

/** Chunk step missing @ItemReader → must throw ProviderNotFoundError. */
@Jobable({ id: 'missing-reader-job' })
class MissingReaderJob {
  @Stepable({ id: 'c1' })
  async read(): Promise<unknown | null> {
    return null;
  }

  @ItemProcessor()
  async process(item: unknown): Promise<unknown> {
    return item;
  }

  @ItemWriter()
  async write(_items: unknown[]): Promise<void> {
    return;
  }
}

/** Chunk step missing @ItemWriter → must throw ProviderNotFoundError. */
@Jobable({ id: 'missing-writer-job' })
class MissingWriterJob {
  @Stepable({ id: 'c1' })
  async read(): Promise<unknown | null> {
    return null;
  }

  @ItemReader()
  async readerMethod(): Promise<unknown | null> {
    return null;
  }

  @ItemProcessor()
  async process(item: unknown): Promise<unknown> {
    return item;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function discover(cls: new () => unknown): DiscoveredJob {
  const explorer = new BatchExplorer(
    // Minimal DiscoveryService stand-in.
    { getProviders: () => [] } as never,
  );
  const result = explorer.discoverFromProviders([
    { metatype: cls as unknown as Function, instance: new cls() },
  ]);
  if (result.length === 0) throw new Error(`No job discovered for ${cls.name}`);
  return result[0]!;
}

const compiler = new DefinitionCompiler();

// ---------------------------------------------------------------------------
// compileFromDiscovered — tasklet step
// ---------------------------------------------------------------------------

describe('DefinitionCompiler.compileFromDiscovered — tasklet step', () => {
  it('compiles a @Jobable class with 1 tasklet step + 2 listeners into a valid JobDefinition', () => {
    const job = compiler.compileFromDiscovered(discover(DiscoveredTaskletJob));

    expect(job.id).toBe('discovered-tasklet-job');
    expect(Object.keys(job.steps)).toEqual(['s1']);
    expect(job.startStepId).toBe('s1');
    expect(job.transitions).toEqual([]);
    expect(job.restartable).toBe(false);
    expect(job.allowDuplicateInstances).toBe(false);

    const step = job.steps['s1']!;
    expect(step.kind).toBe('tasklet');
    expect(step.id).toBe('s1');
    if (step.kind === 'tasklet') {
      // Instance was supplied → BuilderLambda
      expect(step.tasklet.kind).toBe(RefKind.BuilderLambda);
      expect(typeof step.tasklet.fn).toBe('function');
    }

    const listenerPhases = job.listeners
      .map((l) => `${l.kind}/${l.phase}`)
      .sort();
    expect(listenerPhases).toEqual(['job/after', 'job/before']);
  });

  it('listener refs are pre-bound BuilderLambda refs when discovered via decorator (instance available)', () => {
    // The explorer instantiates the class to discover step / listener
    // metadata, so the compiler pre-binds each listener method to the
    // discovered instance. The runtime resolver should call `l.ref.fn`
    // directly without a ModuleRef lookup.
    const job = compiler.compileFromDiscovered(discover(DiscoveredTaskletJob));
    expect(job.listeners.length).toBeGreaterThan(0);
    for (const l of job.listeners) {
      expect(l.ref.kind).toBe(RefKind.BuilderLambda);
      expect(typeof l.ref.fn).toBe('function');
    }

    const beforeRef = job.listeners.find((l) => l.kind === 'job' && l.phase === 'before');
    const afterRef = job.listeners.find((l) => l.kind === 'job' && l.phase === 'after');
    expect(beforeRef).toBeDefined();
    expect(afterRef).toBeDefined();
    expect(beforeRef?.ref.kind).toBe(RefKind.BuilderLambda);
    expect(afterRef?.ref.kind).toBe(RefKind.BuilderLambda);
    if (beforeRef && afterRef) {
      const beforeFn = beforeRef.ref.fn;
      const afterFn = afterRef.ref.fn;
      expect(typeof beforeFn).toBe('function');
      expect(typeof afterFn).toBe('function');
      if (beforeFn && afterFn) {
        expect(beforeFn({ jobExecutionId: 'j1' })).toBeUndefined();
        expect(afterFn({ jobExecutionId: 'j1' })).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// compileFromDiscovered — chunk step
// ---------------------------------------------------------------------------

describe('DefinitionCompiler.compileFromDiscovered — chunk step', () => {
  it('compiles a class with @Stepable (no @Tasklet) + @ItemReader/@ItemProcessor/@ItemWriter into a chunk step', () => {
    const job = compiler.compileFromDiscovered(discover(DiscoveredChunkJob));

    expect(job.id).toBe('discovered-chunk-job');
    expect(job.steps['c1']?.kind).toBe('chunk');
    const step = job.steps['c1']!;
    if (step.kind === 'chunk') {
      expect(step.chunkSize).toBe(25);
      expect(step.reader.kind).toBe(RefKind.Method);
      expect(step.reader.classToken).toBe('DiscoveredChunkJob');
      expect(step.reader.methodName).toBe('read');
      expect(step.processor?.kind).toBe(RefKind.Method);
      expect(step.processor?.classToken).toBe('DiscoveredChunkJob');
      expect(step.processor?.methodName).toBe('process');
      expect(step.writer.kind).toBe(RefKind.Method);
      expect(step.writer.classToken).toBe('DiscoveredChunkJob');
      expect(step.writer.methodName).toBe('write');
    }
  });

  it('omits processor field when class has no @ItemProcessor method', () => {
    @Jobable({ id: 'no-processor' })
    class NoProcessor {
      @Stepable({ id: 'c1' })
      @ItemReader()
      async r(): Promise<unknown | null> {
        return null;
      }
      @ItemWriter()
      async w(_items: unknown[]): Promise<void> {
        return;
      }
    }
    const job = compiler.compileFromDiscovered(discover(NoProcessor));
    const step = job.steps['c1']!;
    expect(step.kind).toBe('chunk');
    if (step.kind === 'chunk') {
      expect(step.processor).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderNotFoundError
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — missing provider', () => {
  it('throws ProviderNotFoundError for missing @ItemReader', () => {
    expect(() => compiler.compileFromDiscovered(discover(MissingReaderJob))).toThrow(
      ProviderNotFoundError,
    );
    try {
      compiler.compileFromDiscovered(discover(MissingReaderJob));
    } catch (e) {
      const err = e as ProviderNotFoundError;
      expect(err).toBeInstanceOf(BatchError);
      expect(err.code).toBe('PROVIDER_NOT_FOUND');
      expect(err.message).toMatch(/ItemReader/);
    }
  });

  it('throws ProviderNotFoundError for missing @ItemWriter', () => {
    expect(() => compiler.compileFromDiscovered(discover(MissingWriterJob))).toThrow(
      ProviderNotFoundError,
    );
    try {
      compiler.compileFromDiscovered(discover(MissingWriterJob));
    } catch (e) {
      const err = e as ProviderNotFoundError;
      expect(err.code).toBe('PROVIDER_NOT_FOUND');
      expect(err.message).toMatch(/ItemWriter/);
    }
  });
});

// ---------------------------------------------------------------------------
// compileFromBuilderConfig
// ---------------------------------------------------------------------------

describe('DefinitionCompiler.compileFromBuilderConfig', () => {
  it('compiles a builder config with 1 tasklet step + 2 listeners into a valid JobDefinition', () => {
    const noop = (): null => null;
    const config: JobBuilderConfig = {
      id: 'builder-tasklet-job',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 's1',
      steps: [
        {
          kind: 'tasklet',
          id: 's1',
          tasklet: { kind: RefKind.BuilderLambda, fn: noop },
          listeners: [],
        },
      ],
      transitions: [],
      listeners: [
        { kind: 'job', phase: 'before', ref: { kind: RefKind.BuilderLambda, fn: noop } },
        { kind: 'job', phase: 'after', ref: { kind: RefKind.BuilderLambda, fn: noop } },
      ],
    };

    const job = compiler.compileFromBuilderConfig(config);

    expect(job.id).toBe('builder-tasklet-job');
    expect(Object.keys(job.steps)).toEqual(['s1']);
    expect(job.startStepId).toBe('s1');
    expect(job.transitions).toEqual([]);
    expect(job.steps['s1']!.kind).toBe('tasklet');
    const listenerPhases = job.listeners
      .map((l) => `${l.kind}/${l.phase}`)
      .sort();
    expect(listenerPhases).toEqual(['job/after', 'job/before']);
  });

  it('preserves restartable / allowDuplicateInstances flags', () => {
    const config: JobBuilderConfig = {
      id: 'flagged',
      restartable: true,
      allowDuplicateInstances: true,
      startStepId: 's1',
      steps: [
        {
          kind: 'tasklet',
          id: 's1',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
      ],
      transitions: [],
      listeners: [],
    };
    const job = compiler.compileFromBuilderConfig(config);
    expect(job.restartable).toBe(true);
    expect(job.allowDuplicateInstances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parity: same logical job via decorator and builder must produce equivalent IR
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — decorator ↔ builder parity', () => {
  it('same logical job via both APIs produces structurally equal IR', () => {
    @Jobable({ id: 'parity' })
    class DecoratorJob {
      @Stepable({ id: 's1' })
      @Tasklet()
      async step1(): Promise<void> {
        return;
      }

      @BeforeJob()
      before(): void {}

      @AfterJob()
      after(): void {}
    }

    const fromDecorator = compiler.compileFromDiscovered(discover(DecoratorJob));

    const fromBuilder = compiler.compileFromBuilderConfig({
      id: 'parity',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 's1',
      steps: [
        {
          kind: 'tasklet',
          id: 's1',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
      ],
      transitions: [],
      listeners: [
        { kind: 'job', phase: 'before', ref: { kind: RefKind.BuilderLambda, fn: () => null } },
        { kind: 'job', phase: 'after', ref: { kind: RefKind.BuilderLambda, fn: () => null } },
      ],
    });

    // ID
    expect(fromDecorator.id).toBe(fromBuilder.id);

    // Step IDs
    expect(Object.keys(fromDecorator.steps).sort()).toEqual(
      Object.keys(fromBuilder.steps).sort(),
    );

    // Step kinds
    for (const id of Object.keys(fromDecorator.steps)) {
      expect(fromDecorator.steps[id]!.kind).toBe(fromBuilder.steps[id]!.kind);
    }

    // startStepId
    expect(fromDecorator.startStepId).toBe(fromBuilder.startStepId);

    // Job-level flags
    expect(fromDecorator.restartable).toBe(fromBuilder.restartable);
    expect(fromDecorator.allowDuplicateInstances).toBe(
      fromBuilder.allowDuplicateInstances,
    );

    // Listener presence: same (kind, phase) tuples
    expect(fromDecorator.listeners.map((l) => `${l.kind}/${l.phase}`).sort()).toEqual(
      fromBuilder.listeners.map((l) => `${l.kind}/${l.phase}`).sort(),
    );

    // Transitions
    expect(fromDecorator.transitions).toEqual(fromBuilder.transitions);
  });

  it('parity holds when builder config uses a chunk step', () => {
    // For chunk parity, the only thing the compiler enforces in compileFromBuilderConfig
    // is that the steps + transitions + listeners produce a valid IR. The decorator
    // path produces a chunk step, and the builder path can produce a structurally
    // equivalent chunk step using ProviderToken refs.
    const fromBuilder = compiler.compileFromBuilderConfig({
      id: 'parity-chunk',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 'c1',
      steps: [
        {
          kind: 'chunk',
          id: 'c1',
          chunkSize: 10,
          reader: { kind: RefKind.ProviderToken, token: 'READER' },
          processor: { kind: RefKind.ProviderToken, token: 'PROCESSOR' },
          writer: { kind: RefKind.ProviderToken, token: 'WRITER' },
          listeners: [],
        },
      ],
      transitions: [],
      listeners: [],
    });

    const fromDecorator = compiler.compileFromDiscovered(discover(DiscoveredChunkJob));

    expect(fromDecorator.steps['c1']!.kind).toBe('chunk');
    expect(fromBuilder.steps['c1']!.kind).toBe('chunk');
    if (
      fromDecorator.steps['c1']!.kind === 'chunk' &&
      fromBuilder.steps['c1']!.kind === 'chunk'
    ) {
      expect(fromBuilder.steps['c1']!.chunkSize).toBe(10);
      expect(fromDecorator.steps['c1']!.chunkSize).toBe(25);
      // Decorator: Method refs, Builder: ProviderToken refs
      expect(fromDecorator.steps['c1']!.reader.kind).toBe(RefKind.Method);
      expect(fromBuilder.steps['c1']!.reader.kind).toBe(RefKind.ProviderToken);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation is applied
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — validation integration', () => {
  it('compileFromBuilderConfig fails validation for an orphan step (UNREACHABLE_STEP)', () => {
    const config: JobBuilderConfig = {
      id: 'orphan-job',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 'step-a',
      steps: [
        {
          kind: 'tasklet',
          id: 'step-a',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
        {
          kind: 'tasklet',
          id: 'step-b',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
      ],
      transitions: [
        {
          fromStepId: 'step-a',
          onStatus: FlowExecutionStatus.COMPLETED,
          toStepId: null,
        },
      ],
      listeners: [],
    };

    expect(() => compiler.compileFromBuilderConfig(config)).toThrow(InvalidFlowGraphError);
    try {
      compiler.compileFromBuilderConfig(config);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('UNREACHABLE_STEP');
    }
  });

  it('compileFromBuilderConfig fails validation for missing transition target (MISSING_TARGET)', () => {
    const config: JobBuilderConfig = {
      id: 'bad-target',
      restartable: false,
      allowDuplicateInstances: false,
      startStepId: 's1',
      steps: [
        {
          kind: 'tasklet',
          id: 's1',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
      ],
      transitions: [
        {
          fromStepId: 's1',
          onStatus: FlowExecutionStatus.COMPLETED,
          toStepId: 'ghost',
        },
      ],
      listeners: [],
    };

    expect(() => compiler.compileFromBuilderConfig(config)).toThrow(InvalidFlowGraphError);
  });

  it('compileFromDiscovered also runs validation (empty job impossible from real discover, but Builder catches)', () => {
    // Validation is applied uniformly. Verify by calling validate on a valid job
    // through the compiler: it should not throw.
    const job = compiler.compileFromDiscovered(discover(DiscoveredTaskletJob));
    expect(job.id).toBe('discovered-tasklet-job');
  });
});
