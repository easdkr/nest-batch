import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';

import {
  BATCH_ITEM_PROCESSOR_METADATA,
  BATCH_ITEM_READER_METADATA,
  BATCH_ITEM_WRITER_METADATA,
  BATCH_LISTENER_METADATA,
  ItemProcessor,
  ItemReader,
  ItemWriter,
  AfterChunk,
  AfterJob,
  AfterProcess,
  AfterRead,
  AfterStep,
  AfterWrite,
  BeforeChunk,
  BeforeJob,
  BeforeProcess,
  BeforeRead,
  BeforeStep,
  BeforeWrite,
  OnChunkError,
  OnProcessError,
  OnReadError,
  OnSkipProcess,
  OnSkipRead,
  OnSkipWrite,
  OnWriteError,
} from '../../src/decorators';

import type { ListenerKind, ListenerPhase } from '../../src/core/ir/listener-definition';

const reflector = new Reflector();

function handler(cls: { prototype: object }, name: string): Function {
  return (cls.prototype as Record<string, unknown>)[name] as Function;
}

// ---------------------------------------------------------------------------
// Fixture class that exercises every decorator in a single definition site.
// We rely on `Class.prototype` so the same class can be re-used across many
// metadata assertions without re-evaluating the decorators.
// ---------------------------------------------------------------------------

class Fixtures {
  // -- Item handlers --
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

  // -- Job listeners --
  @BeforeJob()
  beforeJob(): void {}

  @AfterJob()
  afterJob(): void {}

  // -- Step listeners --
  @BeforeStep()
  beforeStep(): void {}

  @AfterStep()
  afterStep(): void {}

  // -- Chunk listeners --
  @BeforeChunk()
  beforeChunk(): void {}

  @AfterChunk()
  afterChunk(): void {}

  @OnChunkError()
  onChunkError(): void {}

  // -- ItemRead listeners --
  @BeforeRead()
  beforeRead(): void {}

  @AfterRead()
  afterRead(): void {}

  @OnReadError()
  onReadError(): void {}

  // -- ItemProcess listeners --
  @BeforeProcess()
  beforeProcess(): void {}

  @AfterProcess()
  afterProcess(): void {}

  @OnProcessError()
  onProcessError(): void {}

  // -- ItemWrite listeners --
  @BeforeWrite()
  beforeWrite(): void {}

  @AfterWrite()
  afterWrite(): void {}

  @OnWriteError()
  onWriteError(): void {}

  // -- Skip listeners --
  @OnSkipRead()
  onSkipRead(): void {}

  @OnSkipProcess()
  onSkipProcess(): void {}

  @OnSkipWrite()
  onSkipWrite(): void {}
}

// ---------------------------------------------------------------------------
// Item decorator metadata
// ---------------------------------------------------------------------------

describe('item decorator metadata (happy)', () => {
  it('@ItemReader() sets BATCH_ITEM_READER_METADATA on the method handler', () => {
    expect(reflector.get(BATCH_ITEM_READER_METADATA, handler(Fixtures, 'read'))).toEqual({
      kind: 'reader',
      factory: false,
    });
  });

  it('@ItemReader({ factory: true }) marks the reader as a factory', () => {
    class FactoryReader {
      @ItemReader({ factory: true })
      createReader(): void {}
    }

    expect(
      reflector.get(BATCH_ITEM_READER_METADATA, handler(FactoryReader, 'createReader')),
    ).toEqual({
      kind: 'reader',
      factory: true,
    });
  });

  it('@ItemProcessor() sets BATCH_ITEM_PROCESSOR_METADATA on the method handler', () => {
    expect(reflector.get(BATCH_ITEM_PROCESSOR_METADATA, handler(Fixtures, 'process'))).toEqual({
      kind: 'processor',
    });
  });

  it('@ItemWriter() sets BATCH_ITEM_WRITER_METADATA on the method handler', () => {
    expect(reflector.get(BATCH_ITEM_WRITER_METADATA, handler(Fixtures, 'write'))).toEqual({
      kind: 'writer',
    });
  });
});

describe('item decorator metadata (failure / negative)', () => {
  it('class without @ItemReader returns undefined from metadata', () => {
    class NoReader {
      notReader(): void {}
    }
    expect(
      reflector.get(BATCH_ITEM_READER_METADATA, handler(NoReader, 'notReader')),
    ).toBeUndefined();
  });

  it('@ItemReader() on one method does not leak metadata to siblings', () => {
    class OnlyOne {
      @ItemReader()
      onlyOne(): void {}

      other(): void {}
    }
    expect(reflector.get(BATCH_ITEM_READER_METADATA, handler(OnlyOne, 'other'))).toBeUndefined();
    expect(reflector.get(BATCH_ITEM_READER_METADATA, handler(OnlyOne, 'onlyOne'))).toEqual({
      kind: 'reader',
      factory: false,
    });
  });

  it('@ItemReader() applied to a non-method (class position) does not corrupt the class', () => {
    expect(() => {
      try {
        // Bypass TS: we are intentionally testing the runtime path of a
        // method decorator applied at the class position.
        (ItemReader() as unknown as ClassDecorator)(Fixtures);
      } catch {
        // reflect-metadata may throw when propertyKey is undefined; both
        // outcomes are acceptable as long as Fixtures is not corrupted.
      }
    }).not.toThrow();

    expect(reflector.get(BATCH_ITEM_READER_METADATA, handler(Fixtures, 'read'))).toEqual({
      kind: 'reader',
      factory: false,
    });
    expect(new Fixtures()).toBeInstanceOf(Fixtures);
  });
});

// ---------------------------------------------------------------------------
// Listener decorator metadata
// ---------------------------------------------------------------------------

interface ExpectedListener {
  method: string;
  kind: ListenerKind;
  phase: ListenerPhase;
  skipKind?: 'read' | 'process' | 'write';
}

const EXPECTED_LISTENERS: readonly ExpectedListener[] = [
  // Job
  { method: 'beforeJob', kind: 'job', phase: 'before' },
  { method: 'afterJob', kind: 'job', phase: 'after' },
  // Step
  { method: 'beforeStep', kind: 'step', phase: 'before' },
  { method: 'afterStep', kind: 'step', phase: 'after' },
  // Chunk
  { method: 'beforeChunk', kind: 'chunk', phase: 'before' },
  { method: 'afterChunk', kind: 'chunk', phase: 'after' },
  { method: 'onChunkError', kind: 'chunk', phase: 'on-error' },
  // ItemRead
  { method: 'beforeRead', kind: 'item-read', phase: 'before' },
  { method: 'afterRead', kind: 'item-read', phase: 'after' },
  { method: 'onReadError', kind: 'item-read', phase: 'on-error' },
  // ItemProcess
  { method: 'beforeProcess', kind: 'item-process', phase: 'before' },
  { method: 'afterProcess', kind: 'item-process', phase: 'after' },
  { method: 'onProcessError', kind: 'item-process', phase: 'on-error' },
  // ItemWrite
  { method: 'beforeWrite', kind: 'item-write', phase: 'before' },
  { method: 'afterWrite', kind: 'item-write', phase: 'after' },
  { method: 'onWriteError', kind: 'item-write', phase: 'on-error' },
  // Skip (phase 'after' is a placeholder; real implementation in Task 25)
  { method: 'onSkipRead', kind: 'skip', phase: 'after', skipKind: 'read' },
  { method: 'onSkipProcess', kind: 'skip', phase: 'after', skipKind: 'process' },
  { method: 'onSkipWrite', kind: 'skip', phase: 'after', skipKind: 'write' },
] as const;

describe('listener decorator metadata (happy)', () => {
  for (const { method, kind, phase, skipKind } of EXPECTED_LISTENERS) {
    it(`@${method.replace(/^./, (c) => c.toUpperCase())}() → kind='${kind}', phase='${phase}'`, () => {
      const meta = reflector.get(BATCH_LISTENER_METADATA, handler(Fixtures, method));
      expect(meta).toEqual({
        kind,
        phase,
        ...(skipKind !== undefined ? { skipKind } : {}),
      });
    });
  }

  it('all 19 listener decorators are accounted for', () => {
    expect(EXPECTED_LISTENERS).toHaveLength(19);
  });

  it('listener metadata covers all 7 listener kinds', () => {
    const kinds = new Set(EXPECTED_LISTENERS.map((l) => l.kind));
    expect(kinds).toEqual(
      new Set([
        'job',
        'step',
        'chunk',
        'item-read',
        'item-process',
        'item-write',
        'skip',
      ] as ListenerKind[]),
    );
  });
});

describe('listener decorator metadata (failure / negative)', () => {
  it('a method without any listener decorator has no listener metadata', () => {
    class NoListeners {
      plain(): void {}
    }
    expect(reflector.get(BATCH_LISTENER_METADATA, handler(NoListeners, 'plain'))).toBeUndefined();
  });

  it('listener metadata on one method does not leak to other methods', () => {
    class OnlyBefore {
      @BeforeJob()
      before(): void {}

      sibling(): void {}
    }
    expect(reflector.get(BATCH_LISTENER_METADATA, handler(OnlyBefore, 'sibling'))).toBeUndefined();
    expect(reflector.get(BATCH_LISTENER_METADATA, handler(OnlyBefore, 'before'))).toEqual({
      kind: 'job',
      phase: 'before',
    });
  });
});

// ---------------------------------------------------------------------------
// Sanity / coverage
// ---------------------------------------------------------------------------

describe('decorator surface (sanity)', () => {
  it('exports exactly 22 decorators (3 item + 19 listener)', () => {
    const all = {
      // Item (3)
      ItemReader,
      ItemProcessor,
      ItemWriter,
      // Job (2)
      BeforeJob,
      AfterJob,
      // Step (2)
      BeforeStep,
      AfterStep,
      // Chunk (3)
      BeforeChunk,
      AfterChunk,
      OnChunkError,
      // ItemRead (3)
      BeforeRead,
      AfterRead,
      OnReadError,
      // ItemProcess (3)
      BeforeProcess,
      AfterProcess,
      OnProcessError,
      // ItemWrite (3)
      BeforeWrite,
      AfterWrite,
      OnWriteError,
      // Skip (3)
      OnSkipRead,
      OnSkipProcess,
      OnSkipWrite,
    };
    expect(Object.keys(all)).toHaveLength(22);
    for (const [name, fn] of Object.entries(all)) {
      expect(typeof fn, `${name} should be a function`).toBe('function');
    }
  });

  it('all 4 item metadata keys are present and distinct', () => {
    expect(BATCH_ITEM_READER_METADATA).toBe('nest-batch:item-reader');
    expect(BATCH_ITEM_PROCESSOR_METADATA).toBe('nest-batch:item-processor');
    expect(BATCH_ITEM_WRITER_METADATA).toBe('nest-batch:item-writer');
    expect(BATCH_LISTENER_METADATA).toBe('nest-batch:listener');
  });
});
