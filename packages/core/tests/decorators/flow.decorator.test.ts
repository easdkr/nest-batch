import 'reflect-metadata';
import { describe, it, expect } from 'vitest';

import {
  BATCH_TRANSITION_METADATA,
  Jobable,
  Stepable,
  Tasklet,
  OnTransition,
} from '../../src/decorators';
import { BatchExplorer, type DiscoveredJob } from '../../src/explorer/batch-explorer';
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import { FlowExecutionStatus } from '../../src/core/status';
import { FlowBuilder } from '../../src/builder/flow-builder';
import { RefKind } from '../../src/core/ir';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A job with one @OnTransition where toStep is set (forward transition). */
@Jobable({ id: 'flow-decorator-job' })
class FlowDecoratorJob {
  @Stepable({ id: 's1' })
  @Tasklet()
  async s1(): Promise<void> {
    return;
  }

  @Stepable({ id: 's2' })
  @Tasklet()
  async s2(): Promise<void> {
    return;
  }

  @OnTransition({ fromStep: 's1', onStatus: FlowExecutionStatus.FAILED, toStep: 's2' })
  onFail(): void {}
}

/** A job with an END transition (toStep === null). */
@Jobable({ id: 'flow-decorator-end-job' })
class FlowDecoratorEndJob {
  @Stepable({ id: 's1' })
  @Tasklet()
  async s1(): Promise<void> {
    return;
  }

  @OnTransition({
    fromStep: 's1',
    onStatus: FlowExecutionStatus.COMPLETED,
    toStep: null,
  })
  onDone(): void {}
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
// Test 1: @OnTransition sets correct metadata
// ---------------------------------------------------------------------------

describe('@OnTransition metadata (happy)', () => {
  it('@OnTransition attaches BATCH_TRANSITION_METADATA with the given options', () => {
    const meta = Reflect.getMetadata(
      BATCH_TRANSITION_METADATA,
      FlowDecoratorJob.prototype,
      'onFail',
    );
    expect(meta).toEqual({
      fromStep: 's1',
      onStatus: FlowExecutionStatus.FAILED,
      toStep: 's2',
    });
  });

  it('@OnTransition with toStep=null stores the literal null (END transition)', () => {
    const meta = Reflect.getMetadata(
      BATCH_TRANSITION_METADATA,
      FlowDecoratorEndJob.prototype,
      'onDone',
    );
    expect(meta).toEqual({
      fromStep: 's1',
      onStatus: FlowExecutionStatus.COMPLETED,
      toStep: null,
    });
  });

  it('a method without @OnTransition has no BATCH_TRANSITION_METADATA (negative case)', () => {
    class NoTransition {
      notATransition(): void {}
    }
    expect(
      Reflect.getMetadata(BATCH_TRANSITION_METADATA, NoTransition.prototype, 'notATransition'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: DefinitionCompiler reads @OnTransition from a class
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — @OnTransition integration', () => {
  it('reads @OnTransition metadata and adds to transitions[]', () => {
    const job = compiler.compileFromDiscovered(discover(FlowDecoratorJob));
    expect(job.transitions).toEqual([
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.FAILED,
        toStepId: 's2',
      },
    ]);
  });

  it('resolves the onStatus string from FlowExecutionStatus enum', () => {
    // Sanity: the onStatus in the IR is a real FlowExecutionStatus value, not a string.
    const job = compiler.compileFromDiscovered(discover(FlowDecoratorJob));
    expect(job.transitions[0]!.onStatus).toBe(FlowExecutionStatus.FAILED);
  });
});

// ---------------------------------------------------------------------------
// Test 3: toStep=null (END transition) is correctly captured
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — END transitions (toStep=null)', () => {
  it('captures an END transition (toStepId=null) into transitions[]', () => {
    const job = compiler.compileFromDiscovered(discover(FlowDecoratorEndJob));
    expect(job.transitions).toEqual([
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.COMPLETED,
        toStepId: null,
      },
    ]);
    expect(job.transitions[0]!.toStepId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4: parity with builder
// ---------------------------------------------------------------------------

describe('DefinitionCompiler — decorator ↔ builder parity (transitions)', () => {
  it('the same flow expressed via @OnTransition and FlowBuilder produces equivalent IR', () => {
    // Decorator-driven path
    const fromDecorator = compiler.compileFromDiscovered(discover(FlowDecoratorJob));

    // Builder-driven path
    const transition = new FlowBuilder()
      .from('s1')
      .on(FlowExecutionStatus.FAILED)
      .to('s2')
      .build();

    const fromBuilder = compiler.compileFromBuilderConfig({
      id: 'flow-decorator-job',
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
        {
          kind: 'tasklet',
          id: 's2',
          tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
          listeners: [],
        },
      ],
      transitions: [transition],
      listeners: [],
    });

    // The transition IR must be identical regardless of source.
    expect(fromDecorator.transitions).toEqual(fromBuilder.transitions);
    expect(fromDecorator.transitions).toEqual([
      {
        fromStepId: 's1',
        onStatus: FlowExecutionStatus.FAILED,
        toStepId: 's2',
      },
    ]);
  });

  it('parity also holds for END transitions (toStep=null)', () => {
    const fromDecorator = compiler.compileFromDiscovered(discover(FlowDecoratorEndJob));

    const transition = new FlowBuilder()
      .from('s1')
      .on(FlowExecutionStatus.COMPLETED)
      .end()
      .build();

    const fromBuilder = compiler.compileFromBuilderConfig({
      id: 'flow-decorator-end-job',
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
      transitions: [transition],
      listeners: [],
    });

    expect(fromDecorator.transitions).toEqual(fromBuilder.transitions);
    expect(fromDecorator.transitions[0]!.toStepId).toBeNull();
  });
});
