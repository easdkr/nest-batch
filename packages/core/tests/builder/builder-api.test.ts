import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';

import { BatchBuilder } from '../../src/builder/batch-builder';
import { JobBuilder } from '../../src/builder/job-builder';
import { StepBuilder } from '../../src/builder/step-builder';
import { FlowBuilder, defineDecider, defineReusableFlow } from '../../src/builder/flow-builder';
import { RefKind } from '../../src/core/ir';
import { FlowExecutionStatus } from '../../src/core/status';
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
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import { InvalidFlowGraphError } from '../../src/core/errors';
import type { JobBuilderConfig } from '../../src/compiler/builder-types';

// ---------------------------------------------------------------------------
// Shared helpers / fixtures
// ---------------------------------------------------------------------------

const compiler = new DefinitionCompiler();

const noop = (): null => null;

/** Discover a @Jobable class with a noop instance, for parity tests. */
function discover(cls: new () => unknown): DiscoveredJob {
  const explorer = new BatchExplorer(
    {
      getProviders: () => [],
    } as never,
    new Reflector(),
  );
  const result = explorer.discoverFromProviders([
    { metatype: cls as unknown as Function, instance: new cls() },
  ]);
  if (result.length === 0) throw new Error(`No job discovered for ${cls.name}`);
  return result[0]!;
}

// ---------------------------------------------------------------------------
// Test 1 — simple 1-step tasklet job
// ---------------------------------------------------------------------------

describe('Builder API — simple 1-step tasklet job', () => {
  it('builds a JobBuilderConfig with a single tasklet step and accepts it via compileFromBuilderConfig', () => {
    const config = BatchBuilder.create()
      .job('simple-tasklet')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .build();

    // 1a. Plain-data shape is exactly what the compiler expects.
    expect(config.id).toBe('simple-tasklet');
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0]!.id).toBe('s1');
    expect(config.steps[0]!.kind).toBe('tasklet');
    expect(config.startStepId).toBe('s1');
    expect(config.transitions).toEqual([]);
    expect(config.listeners).toEqual([]);
    expect(config.restartable).toBe(false);
    expect(config.allowDuplicateInstances).toBe(false);

    // 1b. The compiler accepts the produced config and produces a valid IR.
    const job = compiler.compileFromBuilderConfig(config);
    expect(job.id).toBe('simple-tasklet');
    expect(job.startStepId).toBe('s1');
    expect(Object.keys(job.steps)).toEqual(['s1']);
    if (job.steps['s1']!.kind === 'tasklet') {
      expect(job.steps['s1']!.tasklet.kind).toBe(RefKind.BuilderLambda);
    } else {
      throw new Error('expected tasklet step');
    }
  });

  it('preserves restartable / allowDuplicateInstances flags', () => {
    const config = BatchBuilder.create()
      .job('flagged')
      .restartable(true)
      .allowDuplicateInstances(true)
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .build();

    expect(config.restartable).toBe(true);
    expect(config.allowDuplicateInstances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — 2-step job: chunk + tasklet
// ---------------------------------------------------------------------------

describe('Builder API — 2-step job (chunk + tasklet)', () => {
  it('builds a 2-step job in declaration order, preserving chunk and tasklet kinds', () => {
    const config = BatchBuilder.create()
      .job('mixed-2-step')
      .addStep((b) =>
        b.chunk('read-csv', 50, {
          reader: { kind: RefKind.BuilderLambda, fn: noop },
          processor: { kind: RefKind.BuilderLambda, fn: (x) => x },
          writer: { kind: RefKind.BuilderLambda, fn: noop },
        }),
      )
      .addStep((b) => b.tasklet('cleanup', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('read-csv')
      .on(FlowExecutionStatus.COMPLETED)
      .to('cleanup')
      .build();

    expect(config.steps).toHaveLength(2);
    expect(config.steps[0]!.id).toBe('read-csv');
    expect(config.steps[0]!.kind).toBe('chunk');
    expect(config.steps[1]!.id).toBe('cleanup');
    expect(config.steps[1]!.kind).toBe('tasklet');
    expect(config.startStepId).toBe('read-csv');

    const job = compiler.compileFromBuilderConfig(config);
    expect(Object.keys(job.steps).sort()).toEqual(['cleanup', 'read-csv']);
    expect(job.steps['read-csv']!.kind).toBe('chunk');
    expect(job.steps['cleanup']!.kind).toBe('tasklet');
  });

  it('chunk step without processor is accepted (processor is optional)', () => {
    const config = BatchBuilder.create()
      .job('chunk-no-proc')
      .addStep((b) =>
        b.chunk('c1', 10, {
          reader: { kind: RefKind.BuilderLambda, fn: noop },
          writer: { kind: RefKind.BuilderLambda, fn: noop },
        }),
      )
      .build();

    const job = compiler.compileFromBuilderConfig(config);
    const step = job.steps['c1']!;
    if (step.kind === 'chunk') {
      expect(step.processor).toBeUndefined();
      expect(step.chunkSize).toBe(10);
    } else {
      throw new Error('expected chunk step');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — flow transition: .from(stepId).on(status).to(stepId)
// ---------------------------------------------------------------------------

describe('Builder API — flow transitions', () => {
  it('records a .from(s).on(FAILED).to(t) transition into JobBuilderConfig', () => {
    const config = BatchBuilder.create()
      .job('with-failed-flow')
      .addStep((b) => b.tasklet('main', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('recovery', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('main')
      .on(FlowExecutionStatus.FAILED)
      .to('recovery')
      .build();

    expect(config.transitions).toEqual([
      {
        fromStepId: 'main',
        onStatus: FlowExecutionStatus.FAILED,
        toStepId: 'recovery',
      },
    ]);
  });

  it('supports multiple transitions chained on the same builder', () => {
    const config = BatchBuilder.create()
      .job('multi-flow')
      .addStep((b) => b.tasklet('a', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('b', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('c', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('a')
      .on(FlowExecutionStatus.COMPLETED)
      .to('b')
      .from('b')
      .on(FlowExecutionStatus.FAILED)
      .to('c')
      .build();

    expect(config.transitions).toEqual([
      { fromStepId: 'a', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'b' },
      { fromStepId: 'b', onStatus: FlowExecutionStatus.FAILED, toStepId: 'c' },
    ]);
  });

  it('throws when .on() is called before .from()', () => {
    expect(() => {
      BatchBuilder.create()
        .job('bad-flow')
        .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
        .on(FlowExecutionStatus.FAILED)
        .to('s1');
    }).toThrow(/from/);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — .end() produces toStepId: null
// ---------------------------------------------------------------------------

describe('Builder API — .end() produces END transition', () => {
  it('.end() commits a transition with toStepId === null', () => {
    const config = BatchBuilder.create()
      .job('end-flow')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('s1')
      .on(FlowExecutionStatus.STOPPED)
      .end()
      .build();

    expect(config.transitions).toEqual([
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.STOPPED,
        toStepId: null,
      },
    ]);
  });

  it('a mix of .to() and .end() produces the expected transition list', () => {
    const config = BatchBuilder.create()
      .job('mixed-end')
      .addStep((b) => b.tasklet('a', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('b', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('a')
      .on(FlowExecutionStatus.COMPLETED)
      .to('b')
      .from('b')
      .on(FlowExecutionStatus.FAILED)
      .end()
      .build();

    expect(config.transitions).toEqual([
      { fromStepId: 'a', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'b' },
      { fromStepId: 'b', onStatus: FlowExecutionStatus.FAILED, toStepId: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — invalid flow: cycle throws via DefinitionCompiler
// ---------------------------------------------------------------------------

describe('Builder API — invalid flow is caught', () => {
  it('a cyclic transition graph is rejected by DefinitionCompiler.compileFromBuilderConfig', () => {
    const config = BatchBuilder.create()
      .job('cycle')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('s2', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('s1')
      .on(FlowExecutionStatus.COMPLETED)
      .to('s2')
      .from('s2')
      .on(FlowExecutionStatus.COMPLETED)
      .to('s1')
      .build();

    // The builder itself produces a syntactically valid config; the
    // structural cycle is caught downstream by the validator inside the
    // compiler, with a stable `CYCLE_DETECTED` code.
    expect(() => compiler.compileFromBuilderConfig(config)).toThrow(InvalidFlowGraphError);
    try {
      compiler.compileFromBuilderConfig(config);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('CYCLE_DETECTED');
    }
  });

  it('a transition whose `to` references an unknown step is rejected (MISSING_TARGET)', () => {
    const config = BatchBuilder.create()
      .job('bad-target')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .from('s1')
      .on(FlowExecutionStatus.COMPLETED)
      .to('ghost')
      .build();

    expect(() => compiler.compileFromBuilderConfig(config)).toThrow(InvalidFlowGraphError);
    try {
      compiler.compileFromBuilderConfig(config);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6 — builder parity with decorator-discovered job
// ---------------------------------------------------------------------------

describe('Builder API — decorator ↔ builder parity', () => {
  it('same logical 1-step tasklet job via both APIs produces equivalent IR', () => {
    @Jobable({ id: 'parity-1' })
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

    const config = BatchBuilder.create()
      .job('parity-1')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .addListener({
        kind: 'job',
        phase: 'before',
        ref: { kind: RefKind.BuilderLambda, fn: noop },
      })
      .addListener({
        kind: 'job',
        phase: 'after',
        ref: { kind: RefKind.BuilderLambda, fn: noop },
      })
      .build();

    const fromBuilder = compiler.compileFromBuilderConfig(config);

    // id, step ids, step kind, start step, flags, listener kinds/phases, transitions
    expect(fromBuilder.id).toBe(fromDecorator.id);
    expect(Object.keys(fromBuilder.steps).sort()).toEqual(Object.keys(fromDecorator.steps).sort());
    for (const id of Object.keys(fromBuilder.steps)) {
      expect(fromBuilder.steps[id]!.kind).toBe(fromDecorator.steps[id]!.kind);
    }
    expect(fromBuilder.startStepId).toBe(fromDecorator.startStepId);
    expect(fromBuilder.restartable).toBe(fromDecorator.restartable);
    expect(fromBuilder.allowDuplicateInstances).toBe(fromDecorator.allowDuplicateInstances);
    expect(fromBuilder.listeners.map((l) => `${l.kind}/${l.phase}`).sort()).toEqual(
      fromDecorator.listeners.map((l) => `${l.kind}/${l.phase}`).sort(),
    );
    expect(fromBuilder.transitions).toEqual(fromDecorator.transitions);
  });

  it('parity holds for a chunk step built via the builder', () => {
    @Jobable({ id: 'parity-chunk' })
    class DecoratorChunkJob {
      @Stepable({ id: 'c1', chunkSize: 10 })
      @ItemReader()
      async r(): Promise<unknown | null> {
        return null;
      }
      @ItemProcessor()
      async p(item: unknown): Promise<unknown> {
        return item;
      }
      @ItemWriter()
      async w(_items: unknown[]): Promise<void> {
        return;
      }
    }
    const fromDecorator = compiler.compileFromDiscovered(discover(DecoratorChunkJob));

    const config = BatchBuilder.create()
      .job('parity-chunk')
      .addStep((b) =>
        b.chunk('c1', 10, {
          reader: { kind: RefKind.BuilderLambda, fn: noop },
          processor: { kind: RefKind.BuilderLambda, fn: (x: unknown) => x },
          writer: { kind: RefKind.BuilderLambda, fn: noop },
        }),
      )
      .build();

    const fromBuilder = compiler.compileFromBuilderConfig(config);

    expect(fromBuilder.steps['c1']!.kind).toBe('chunk');
    expect(fromDecorator.steps['c1']!.kind).toBe('chunk');
    if (fromBuilder.steps['c1']!.kind === 'chunk' && fromDecorator.steps['c1']!.kind === 'chunk') {
      expect(fromBuilder.steps['c1']!.chunkSize).toBe(fromDecorator.steps['c1']!.chunkSize);
    }
    expect(fromBuilder.startStepId).toBe('c1');
  });
});

// ---------------------------------------------------------------------------
// Test 7 — build with no steps throws
// ---------------------------------------------------------------------------

describe('Builder API — empty job is rejected at build time', () => {
  it('build() throws when no steps have been added', () => {
    const empty: JobBuilder = BatchBuilder.create().job('empty');
    expect(() => empty.build()).toThrow(/no steps/i);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — missing required fields on a chunk step throw at build time
// ---------------------------------------------------------------------------

describe('Builder API — step shape validation at build time', () => {
  it('chunk() rejects a non-positive chunk size', () => {
    expect(() => {
      new StepBuilder().chunk('c1', 0, {
        reader: { kind: RefKind.BuilderLambda, fn: noop },
        writer: { kind: RefKind.BuilderLambda, fn: noop },
      });
    }).toThrow(/chunkSize/);

    expect(() => {
      new StepBuilder().chunk('c1', -5, {
        reader: { kind: RefKind.BuilderLambda, fn: noop },
        writer: { kind: RefKind.BuilderLambda, fn: noop },
      });
    }).toThrow(/chunkSize/);
  });

  it('StepBuilder.build() throws when no id has been set', () => {
    expect(() => new StepBuilder().build()).toThrow(/id/);
  });

  it('StepBuilder.build() throws when chunk() is called but reader/writer are missing', () => {
    const sb = new StepBuilder().chunk('c1', 10);
    expect(() => sb.build()).toThrow(/reader\+writer|tasklet or chunk/i);
  });

  it('a fully-configured chunk step via StepBuilder.chunk() produces a valid IR step', () => {
    const step = new StepBuilder()
      .chunk('c1', 25, {
        reader: { kind: RefKind.BuilderLambda, fn: noop },
        writer: { kind: RefKind.BuilderLambda, fn: noop },
      })
      .build();

    expect(step.kind).toBe('chunk');
    if (step.kind === 'chunk') {
      expect(step.id).toBe('c1');
      expect(step.chunkSize).toBe(25);
      expect(step.reader.kind).toBe(RefKind.BuilderLambda);
      expect(step.writer.kind).toBe(RefKind.BuilderLambda);
      expect(step.processor).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9 — FlowBuilder standalone (bonus)
// ---------------------------------------------------------------------------

describe('FlowBuilder — standalone transition builder', () => {
  it('builds a TransitionDefinition via .from().on().to()', () => {
    const t = new FlowBuilder().from('s1').on(FlowExecutionStatus.FAILED).to('s2').build();

    expect(t).toEqual({
      fromStepId: 's1',
      onStatus: FlowExecutionStatus.FAILED,
      toStepId: 's2',
    });
  });

  it('builds an END transition via .end()', () => {
    const t = new FlowBuilder().from('s1').on(FlowExecutionStatus.STOPPED).end().build();

    expect(t.toStepId).toBeNull();
  });

  it('throws on incomplete chains (no .to()/.end())', () => {
    expect(() => {
      new FlowBuilder().from('s1').on(FlowExecutionStatus.FAILED).build();
    }).toThrow(/committed/);
  });

  it('throws when .on() precedes .from()', () => {
    expect(() => {
      new FlowBuilder().on(FlowExecutionStatus.FAILED);
    }).toThrow(/from/);
  });

  it('FlowBuilder.from(stepId) static helper starts the chain', () => {
    const t = FlowBuilder.from('s1').on(FlowExecutionStatus.COMPLETED).to('s2').build();
    expect(t.fromStepId).toBe('s1');
    expect(t.onStatus).toBe(FlowExecutionStatus.COMPLETED);
    expect(t.toStepId).toBe('s2');
  });

  it('accepts string exit-code patterns in transition builders', () => {
    const t = FlowBuilder.from('s1').on('FAILED_*').to('recovery').build();

    expect(t).toEqual({
      fromStepId: 's1',
      onStatus: 'FAILED_*',
      toStepId: 'recovery',
    });
  });

  it('reuses transition and decider bundles through JobBuilder.useFlow()', () => {
    const flow = defineReusableFlow({
      transitions: [
        FlowBuilder.from('s1').on('EMPTY').to('empty').build(),
        FlowBuilder.from('s1').on(FlowExecutionStatus.COMPLETED).to('done').build(),
      ],
      deciders: [
        defineDecider('s1', ({ exitCode }) => (exitCode === 'NO_DATA' ? 'EMPTY' : 'COMPLETED')),
      ],
    });

    const config = BatchBuilder.create()
      .job('reusable-flow')
      .addStep((b) => b.tasklet('s1', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('empty', { kind: RefKind.BuilderLambda, fn: noop }))
      .addStep((b) => b.tasklet('done', { kind: RefKind.BuilderLambda, fn: noop }))
      .useFlow(flow)
      .build();

    expect(config.transitions).toHaveLength(2);
    expect(config.deciders).toHaveLength(1);

    const job = compiler.compileFromBuilderConfig(config);
    expect(job.transitions.map((t) => t.toStepId)).toEqual(['empty', 'done']);
    expect(job.deciders?.[0]?.afterStepId).toBe('s1');
  });
});

// ---------------------------------------------------------------------------
// Sanity: JobBuilderConfig parity
// ---------------------------------------------------------------------------

describe('Builder API — JobBuilderConfig shape', () => {
  it('compileFromBuilderConfig accepts a hand-rolled config (sanity check on the type)', () => {
    const config: JobBuilderConfig = {
      id: 'hand-rolled',
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
      listeners: [],
    };

    const job = compiler.compileFromBuilderConfig(config);
    expect(job.id).toBe('hand-rolled');
  });
});
