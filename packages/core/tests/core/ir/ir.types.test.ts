import { describe, expect, expectTypeOf, it } from 'vitest';
import { RefKind, FlowExecutionStatus } from '../../../src/core';
import type {
  ChunkStepDefinition,
  JobDefinition,
  ListenerDefinition,
  ListenerKind,
  ReaderRef,
  StepDefinition,
  TaskletRef,
  TaskletStepDefinition,
  TransitionDefinition,
  WriterRef,
} from '../../../src/core/ir';

describe('IR types', () => {
  describe('JobDefinition', () => {
    it('compiles a JobDefinition with a single tasklet step', () => {
      const tasklet: TaskletStepDefinition = {
        kind: 'tasklet',
        id: 'step-1',
        tasklet: {
          kind: RefKind.BuilderLambda,
          fn: () => undefined,
        },
        listeners: [],
      };

      const job: JobDefinition = {
        id: 'job-1',
        steps: {
          'step-1': tasklet,
        },
        startStepId: 'step-1',
        transitions: [],
        listeners: [],
        restartable: false,
        allowDuplicateInstances: false,
      };

      expectTypeOf(job).toMatchTypeOf<JobDefinition>();
      expect(job.id).toBe('job-1');
      expect(job.startStepId).toBe('step-1');
      expect(Object.keys(job.steps)).toEqual(['step-1']);
    });
  });

  describe('StepDefinition (discriminated union)', () => {
    it('a chunk step is assignable to StepDefinition and narrows via kind === "chunk"', () => {
      const reader: ReaderRef = {
        kind: RefKind.ProviderToken,
        token: 'CSV_READER',
      };
      const writer: WriterRef = {
        kind: RefKind.ProviderToken,
        token: 'PRODUCT_WRITER',
      };

      const chunk: ChunkStepDefinition = {
        kind: 'chunk',
        id: 'import-csv',
        chunkSize: 100,
        reader,
        writer,
        listeners: [],
      };

      const step: StepDefinition = chunk;
      expectTypeOf(step).toMatchTypeOf<StepDefinition>();

      if (step.kind === 'chunk') {
        expectTypeOf(step).toMatchTypeOf<ChunkStepDefinition>();
        expect(step.chunkSize).toBe(100);
        expect(step.reader.token).toBe('CSV_READER');
      } else {
        throw new Error('expected chunk narrowing');
      }
    });

    it('a tasklet step is assignable to StepDefinition and narrows via kind === "tasklet"', () => {
      const taskletRef: TaskletRef = {
        kind: RefKind.BuilderLambda,
        fn: () => undefined,
      };
      const tasklet: TaskletStepDefinition = {
        kind: 'tasklet',
        id: 'cleanup',
        tasklet: taskletRef,
        listeners: [],
      };

      const step: StepDefinition = tasklet;
      expectTypeOf(step).toMatchTypeOf<StepDefinition>();

      if (step.kind === 'tasklet') {
        expectTypeOf(step).toMatchTypeOf<TaskletStepDefinition>();
        expect(step.tasklet.kind).toBe(RefKind.BuilderLambda);
      } else {
        throw new Error('expected tasklet narrowing');
      }
    });
  });

  describe('TransitionDefinition', () => {
    it('compiles with toStepId: null (END)', () => {
      const t: TransitionDefinition = {
        fromStepId: 'step-1',
        onStatus: FlowExecutionStatus.COMPLETED,
        toStepId: null,
      };

      expectTypeOf(t).toMatchTypeOf<TransitionDefinition>();
      expect(t.toStepId).toBeNull();
    });

    it('compiles with toStepId: string (jump to next step)', () => {
      const t: TransitionDefinition = {
        fromStepId: 'step-1',
        onStatus: FlowExecutionStatus.FAILED,
        toStepId: 'step-2',
      };

      expectTypeOf(t).toMatchTypeOf<TransitionDefinition>();
      expect(t.toStepId).toBe('step-2');
    });
  });

  describe('ListenerDefinition', () => {
    const allKinds: ListenerKind[] = [
      'job',
      'step',
      'chunk',
      'item-read',
      'item-process',
      'item-write',
      'skip',
      'transition',
    ];

    it.each(allKinds)('compiles a ListenerDefinition for kind=%s', (kind) => {
      const listener: ListenerDefinition = {
        kind,
        ref: {
          kind: RefKind.BuilderLambda,
          fn: () => undefined,
        },
        phase: 'before',
        nonCritical: false,
      };

      expectTypeOf(listener).toMatchTypeOf<ListenerDefinition>();
      expect(listener.kind).toBe(kind);
      expect(listener.phase).toBe('before');
    });

    it('ListenerKind has exactly 8 kinds', () => {
      expect(allKinds).toHaveLength(8);
    });
  });
});
