import { describe, it, expect, vi } from 'vitest';
import { JobRegistry } from '../../src/registry/job-registry';
import { DefinitionValidator } from '../../src/core/validation/definition-validator';
import {
  DuplicateJobDefinitionError,
  JobNotFoundError,
  InvalidFlowGraphError,
} from '../../src/core/errors';
import { RefKind, type JobDefinition } from '../../src/core/ir';
import { FlowExecutionStatus } from '../../src/core/status';

function makeValidJob(id: string): JobDefinition {
  return {
    id,
    steps: {
      s1: {
        kind: 'tasklet',
        id: 's1',
        tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
        listeners: [],
      },
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

function makeCyclicJob(id: string): JobDefinition {
  return {
    id,
    steps: {
      a: {
        kind: 'tasklet',
        id: 'a',
        tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
        listeners: [],
      },
      b: {
        kind: 'tasklet',
        id: 'b',
        tasklet: { kind: RefKind.BuilderLambda, fn: () => null },
        listeners: [],
      },
    },
    startStepId: 'a',
    transitions: [
      { fromStepId: 'a', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'b' },
      { fromStepId: 'b', onStatus: FlowExecutionStatus.COMPLETED, toStepId: 'a' },
    ],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

describe('JobRegistry', () => {
  it('register + get returns the same definition (deep equal)', () => {
    const registry = new JobRegistry();
    const job = makeValidJob('job-1');
    registry.register(job);
    expect(registry.get('job-1')).toEqual(job);
  });

  it('invokes DefinitionValidator.validate on register', () => {
    const validateSpy = vi.spyOn(DefinitionValidator.prototype, 'validate');
    try {
      const registry = new JobRegistry();
      const job = makeValidJob('job-spy');
      registry.register(job);
      expect(validateSpy).toHaveBeenCalledTimes(1);
      expect(validateSpy).toHaveBeenCalledWith(job);
    } finally {
      validateSpy.mockRestore();
    }
  });

  it('duplicate job.id throws DuplicateJobDefinitionError with code DUPLICATE_JOB', () => {
    const registry = new JobRegistry();
    const job = makeValidJob('job-dup');
    registry.register(job);
    expect(() => registry.register(job)).toThrow(DuplicateJobDefinitionError);
    try {
      registry.register(makeValidJob('job-dup'));
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateJobDefinitionError);
      expect((err as DuplicateJobDefinitionError).code).toBe('DUPLICATE_JOB');
    }
  });

  it('does not store jobs that fail validation (cycle)', () => {
    const registry = new JobRegistry();
    const cyclic = makeCyclicJob('job-cycle');
    expect(() => registry.register(cyclic)).toThrow(InvalidFlowGraphError);
    try {
      registry.register(cyclic);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFlowGraphError);
      expect((err as InvalidFlowGraphError).code).toBe('CYCLE_DETECTED');
    }
    expect(registry.has('job-cycle')).toBe(false);
  });

  it('get for missing job throws JobNotFoundError', () => {
    const registry = new JobRegistry();
    expect(() => registry.get('does-not-exist')).toThrow(JobNotFoundError);
    try {
      registry.get('does-not-exist');
    } catch (err) {
      expect(err).toBeInstanceOf(JobNotFoundError);
      expect((err as JobNotFoundError).code).toBe('JOB_NOT_FOUND');
    }
  });

  it('has returns true for registered, false for missing', () => {
    const registry = new JobRegistry();
    registry.register(makeValidJob('job-h'));
    expect(registry.has('job-h')).toBe(true);
    expect(registry.has('job-missing')).toBe(false);
  });

  it('getAll returns all registered definitions', () => {
    const registry = new JobRegistry();
    const j1 = makeValidJob('a');
    const j2 = makeValidJob('b');
    const j3 = makeValidJob('c');
    registry.register(j1);
    registry.register(j2);
    registry.register(j3);
    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all).toEqual(expect.arrayContaining([j1, j2, j3]));
  });

  it('register order does not matter; second valid register still works', () => {
    const registry = new JobRegistry();
    const j1 = makeValidJob('first');
    const j2 = makeValidJob('second');
    registry.register(j1);
    expect(() => registry.register(j2)).not.toThrow();
    expect(registry.get('first')).toEqual(j1);
    expect(registry.get('second')).toEqual(j2);
  });
});
