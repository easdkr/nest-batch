import { describe, expect, it } from 'vitest';
import {
  ChunkStepDefinition,
  FlowExecutionStatus,
  JobDefinition,
  RefKind,
  StepDefinition,
  TaskletStepDefinition,
  TransitionDefinition,
} from '../../../src/core';
import { DefinitionValidator } from '../../../src/core/validation/definition-validator';
import { InvalidFlowGraphError } from '../../../src/core/errors';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTasklet(id: string): TaskletStepDefinition {
  return {
    kind: 'tasklet',
    id,
    tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
    listeners: [],
  };
}

function makeChunk(
  id: string,
  chunkSize = 10,
  extras: Partial<ChunkStepDefinition> = {},
): ChunkStepDefinition {
  return {
    kind: 'chunk',
    id,
    chunkSize,
    reader: { kind: RefKind.ProviderToken, token: `READER_${id}` },
    writer: { kind: RefKind.ProviderToken, token: `WRITER_${id}` },
    listeners: [],
    ...extras,
  };
}

function makeJob(
  partial: Partial<JobDefinition> & Pick<JobDefinition, 'id' | 'steps' | 'startStepId'>,
): JobDefinition {
  return {
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
    ...partial,
  };
}

const validator = new DefinitionValidator();

// ---------------------------------------------------------------------------
// Happy paths — valid jobs must pass without throwing
// ---------------------------------------------------------------------------

describe('DefinitionValidator — happy paths', () => {
  it('accepts a valid 1-tasklet job', () => {
    const job = makeJob({
      id: 'single-tasklet',
      steps: { 'only-step': makeTasklet('only-step') },
      startStepId: 'only-step',
    });
    expect(() => validator.validate(job)).not.toThrow();
  });

  it('accepts a valid 1-chunk job', () => {
    const job = makeJob({
      id: 'single-chunk',
      steps: { 'only-step': makeChunk('only-step') },
      startStepId: 'only-step',
    });
    expect(() => validator.validate(job)).not.toThrow();
  });

  it('accepts a valid 2-step linear job with on(COMPLETED).to("step2") transition', () => {
    const job = makeJob({
      id: 'linear-job',
      steps: {
        step1: makeTasklet('step1'),
        step2: makeTasklet('step2'),
      },
      startStepId: 'step1',
      transitions: [
        {
          fromStepId: 'step1',
          onStatus: FlowExecutionStatus.COMPLETED,
          toStepId: 'step2',
        },
      ],
    });
    expect(() => validator.validate(job)).not.toThrow();
  });

  it('accepts a valid job mixing a tasklet step and a chunk step (kind discrimination)', () => {
    const job = makeJob({
      id: 'mixed-kind',
      steps: {
        setup: makeTasklet('setup'),
        import: makeChunk('import', 50),
        cleanup: makeTasklet('cleanup'),
      },
      startStepId: 'setup',
      transitions: [
        { fromStepId: 'setup', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'import' },
        { fromStepId: 'import', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'cleanup' },
        { fromStepId: 'cleanup', onStatus: FlowExecutionStatus.COMPLETED, toStepId: null },
      ],
    });
    expect(() => validator.validate(job)).not.toThrow();
  });

  it('accepts a job where the only transition is toStepId=null (END)', () => {
    const job = makeJob({
      id: 'end-only',
      steps: { 'only-step': makeTasklet('only-step') },
      startStepId: 'only-step',
      transitions: [
        {
          fromStepId: 'only-step',
          onStatus: FlowExecutionStatus.COMPLETED,
          toStepId: null,
        },
      ],
    });
    expect(() => validator.validate(job)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Negative paths — each invariant throws InvalidFlowGraphError
// ---------------------------------------------------------------------------

describe('DefinitionValidator — negative cases', () => {
  it('rejects empty steps with code EMPTY_JOB', () => {
    const job = makeJob({
      id: 'empty-job',
      steps: {} as Record<string, StepDefinition>,
      startStepId: 'whatever',
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('EMPTY_JOB');
      expect(err.message).toMatch(/empty-job/);
    }
  });

  it('rejects startStepId pointing to a non-existent step with code NO_START_STEP', () => {
    const job = makeJob({
      id: 'no-start',
      steps: { 'real-step': makeTasklet('real-step') },
      startStepId: 'nonexistent',
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('NO_START_STEP');
      expect(err.message).toMatch(/nonexistent/);
    }
  });

  it('rejects a transition whose toStepId does not exist with code MISSING_TARGET', () => {
    const job = makeJob({
      id: 'bad-target',
      steps: { 'step-a': makeTasklet('step-a') },
      startStepId: 'step-a',
      transitions: [
        { fromStepId: 'step-a', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'ghost' },
      ],
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
      expect(err.message).toMatch(/ghost/);
    }
  });

  it('rejects a transition whose fromStepId does not exist with code MISSING_TARGET', () => {
    const job = makeJob({
      id: 'bad-source',
      steps: { 'step-a': makeTasklet('step-a') },
      startStepId: 'step-a',
      transitions: [
        { fromStepId: 'phantom', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'step-a' },
      ],
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
      expect(err.message).toMatch(/phantom/);
    }
  });

  it('rejects an unreachable step with code UNREACHABLE_STEP', () => {
    // step-b exists but has no incoming transition and is not the start.
    const job = makeJob({
      id: 'unreachable',
      steps: {
        'step-a': makeTasklet('step-a'),
        'step-b': makeTasklet('step-b'),
      },
      startStepId: 'step-a',
      transitions: [
        { fromStepId: 'step-a', onStatus: FlowExecutionStatus.COMPLETED, toStepId: null },
      ],
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('UNREACHABLE_STEP');
      expect(err.message).toMatch(/step-b/);
      expect(err.message).toMatch(/step-a/); // startStepId included
    }
  });

  it('rejects a cycle (A→B→A) with code CYCLE_DETECTED', () => {
    const job = makeJob({
      id: 'cyclic',
      steps: {
        A: makeTasklet('A'),
        B: makeTasklet('B'),
      },
      startStepId: 'A',
      transitions: [
        { fromStepId: 'A', onStatus: FlowExecutionStatus.FAILED, toStepId: 'B' },
        { fromStepId: 'B', onStatus: FlowExecutionStatus.FAILED, toStepId: 'A' },
      ],
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('CYCLE_DETECTED');
      // Path should include the cycle nodes
      expect(err.message).toMatch(/A/);
      expect(err.message).toMatch(/B/);
    }
  });

  it('rejects a chunk step with chunkSize <= 0 with code INVALID_CHUNK_SIZE', () => {
    const job = makeJob({
      id: 'bad-chunk-size',
      steps: { 'bad-chunk': makeChunk('bad-chunk', 0) },
      startStepId: 'bad-chunk',
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('INVALID_CHUNK_SIZE');
      expect(err.message).toMatch(/bad-chunk/);
      expect(err.message).toMatch(/0/);
    }
  });

  it('rejects a chunk step with negative chunkSize with code INVALID_CHUNK_SIZE', () => {
    const job = makeJob({
      id: 'neg-chunk',
      steps: { 'neg-chunk': makeChunk('neg-chunk', -5) },
      startStepId: 'neg-chunk',
    });
    expect(() => validator.validate(job)).toThrow(InvalidFlowGraphError);
    try {
      validator.validate(job);
    } catch (e) {
      expect((e as InvalidFlowGraphError).code).toBe('INVALID_CHUNK_SIZE');
    }
  });
});

// ---------------------------------------------------------------------------
// Error-message semantics — make sure the messages are diagnostic
// ---------------------------------------------------------------------------

describe('DefinitionValidator — error message diagnostics', () => {
  it('includes the stepId in the error message when applicable', () => {
    const job = makeJob({
      id: 'diag',
      steps: { 'my-special-step': makeTasklet('my-special-step') },
      startStepId: 'my-special-step',
      transitions: [
        {
          fromStepId: 'my-special-step',
          onStatus: FlowExecutionStatus.COMPLETED,
          toStepId: 'somewhere',
        },
      ],
    });
    expect(() => validator.validate(job)).toThrow(/somewhere/);
  });

  it('includes the jobId in the CYCLE_DETECTED error message', () => {
    const job = makeJob({
      id: 'my-unique-job-id-42',
      steps: { A: makeTasklet('A'), B: makeTasklet('B') },
      startStepId: 'A',
      transitions: [
        { fromStepId: 'A', onStatus: FlowExecutionStatus.FAILED, toStepId: 'B' },
        { fromStepId: 'B', onStatus: FlowExecutionStatus.FAILED, toStepId: 'A' },
      ],
    });
    expect(() => validator.validate(job)).toThrow(/my-unique-job-id-42/);
  });

  it('attaches structured details to the error', () => {
    const job = makeJob({
      id: 'detail-job',
      steps: { 's1': makeTasklet('s1') },
      startStepId: 's1',
      transitions: [
        { fromStepId: 's1', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'ghost' },
      ],
    });
    try {
      validator.validate(job);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
      expect(err.details).toBeDefined();
      expect((err.details as { toStepId: string }).toStepId).toBe('ghost');
    }
  });
});

// ---------------------------------------------------------------------------
// validateTransition — partial / helper API used by FlowEvaluator & Builder
// ---------------------------------------------------------------------------

describe('DefinitionValidator.validateTransition (partial validation)', () => {
  it('passes when all transition endpoints are in the available steps', () => {
    const transitions: TransitionDefinition[] = [
      { fromStepId: 'A', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'B' },
      { fromStepId: 'B', onStatus: FlowExecutionStatus.COMPLETED, toStepId: null },
    ];
    const available: Record<string, StepDefinition> = {
      A: makeTasklet('A'),
      B: makeChunk('B'),
    };
    expect(() => validator.validateTransition(transitions, available)).not.toThrow();
  });

  it('throws MISSING_TARGET when toStepId is not in available steps', () => {
    const transitions: TransitionDefinition[] = [
      { fromStepId: 'A', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'X' },
    ];
    const available: Record<string, StepDefinition> = {
      A: makeTasklet('A'),
    };
    try {
      validator.validateTransition(transitions, available);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
      expect(err.message).toMatch(/X/);
    }
  });

  it('throws MISSING_TARGET when fromStepId is not in available steps', () => {
    const transitions: TransitionDefinition[] = [
      { fromStepId: 'Y', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'A' },
    ];
    const available: Record<string, StepDefinition> = {
      A: makeTasklet('A'),
    };
    try {
      validator.validateTransition(transitions, available);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as InvalidFlowGraphError;
      expect(err.code).toBe('MISSING_TARGET');
      expect(err.message).toMatch(/Y/);
    }
  });

  it('allows toStepId=null (END) without checking against available steps', () => {
    const transitions: TransitionDefinition[] = [
      { fromStepId: 'A', onStatus: FlowExecutionStatus.COMPLETED, toStepId: null },
    ];
    const available: Record<string, StepDefinition> = {
      A: makeTasklet('A'),
    };
    expect(() => validator.validateTransition(transitions, available)).not.toThrow();
  });

  it('does NOT enforce reachability or cycles (partial scope)', () => {
    // A cycle that would fail validate() must pass validateTransition()
    // because the partial helper only checks endpoint existence.
    const transitions: TransitionDefinition[] = [
      { fromStepId: 'A', onStatus: FlowExecutionStatus.FAILED, toStepId: 'B' },
      { fromStepId: 'B', onStatus: FlowExecutionStatus.FAILED, toStepId: 'A' },
    ];
    const available: Record<string, StepDefinition> = {
      A: makeTasklet('A'),
      B: makeTasklet('B'),
    };
    expect(() => validator.validateTransition(transitions, available)).not.toThrow();
  });
});
