import { describe, expect, it } from 'vitest';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { FlowExecutionStatus, InvalidFlowGraphError } from '../../src/core';
import type { TransitionDefinition } from '../../src/core/ir';

const t = (
  fromStepId: string,
  onStatus: FlowExecutionStatus,
  toStepId: string | null,
): TransitionDefinition => ({ fromStepId, onStatus, toStepId });

describe('FlowEvaluator', () => {
  const evaluator = new FlowEvaluator();

  describe('happy path', () => {
    it('returns the toStepId of a single matching transition', async () => {
      const result = await evaluator.evaluate(
        [t('s1', FlowExecutionStatus.COMPLETED, 's2')],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBe('s2');
    });

    it('returns null (END) when the matching transition has toStepId = null', async () => {
      const result = await evaluator.evaluate(
        [t('s1', FlowExecutionStatus.COMPLETED, null)],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBeNull();
    });

    it('returns null (END) when no transition matches (different fromStepId)', async () => {
      const result = await evaluator.evaluate(
        [t('other', FlowExecutionStatus.COMPLETED, 's2')],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBeNull();
    });

    it('returns null (END) when no transition matches (different onStatus)', async () => {
      const result = await evaluator.evaluate(
        [t('s1', FlowExecutionStatus.FAILED, 's2')],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBeNull();
    });

    it('returns null (END) when the transition list is empty', async () => {
      const result = await evaluator.evaluate([], 's1', FlowExecutionStatus.COMPLETED);
      expect(result).toBeNull();
    });
  });

  describe('multi-transition graph', () => {
    it('ignores transitions whose fromStepId differs from the current step', async () => {
      const result = await evaluator.evaluate(
        [
          t('other1', FlowExecutionStatus.COMPLETED, 'noise1'),
          t('s1', FlowExecutionStatus.COMPLETED, 's2'),
          t('other2', FlowExecutionStatus.FAILED, 'noise2'),
        ],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBe('s2');
    });

    it('matches on BOTH fromStepId AND onStatus, not either alone', async () => {
      // Same from, different status -> should NOT match the COMPLETED query
      const sameFrom = t('s1', FlowExecutionStatus.FAILED, 's-failed');
      // Different from, same status -> should NOT match the (s1, COMPLETED) query
      const sameStatus = t('s2', FlowExecutionStatus.COMPLETED, 's2-out');
      // Actual match: s1 + COMPLETED -> s-done
      const realMatch = t('s1', FlowExecutionStatus.COMPLETED, 's-done');

      const result = await evaluator.evaluate(
        [sameFrom, sameStatus, realMatch],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(result).toBe('s-done');
    });

    it('selects the right branch for FAILED even when COMPLETED is also defined', async () => {
      const result = await evaluator.evaluate(
        [
          t('s1', FlowExecutionStatus.COMPLETED, 's2'),
          t('s1', FlowExecutionStatus.FAILED, 's-error-handler'),
        ],
        's1',
        FlowExecutionStatus.FAILED,
      );
      expect(result).toBe('s-error-handler');
    });
  });

  describe('ambiguity', () => {
    it('throws InvalidFlowGraphError with code AMBIGUOUS_TRANSITION when 2 transitions match', async () => {
      const ambiguous: TransitionDefinition[] = [
        t('s1', FlowExecutionStatus.COMPLETED, 's2'),
        t('s1', FlowExecutionStatus.COMPLETED, 's3'),
      ];

      await expect(
        evaluator.evaluate(ambiguous, 's1', FlowExecutionStatus.COMPLETED),
      ).rejects.toThrow(InvalidFlowGraphError);

      await expect(
        evaluator.evaluate(ambiguous, 's1', FlowExecutionStatus.COMPLETED),
      ).rejects.toMatchObject({
        code: 'AMBIGUOUS_TRANSITION',
        name: 'InvalidFlowGraphError',
      });
    });

    it('AMBIGUOUS_TRANSITION error includes fromStepId, status, and match count in details', async () => {
      const ambiguous: TransitionDefinition[] = [
        t('s1', FlowExecutionStatus.COMPLETED, 's2'),
        t('s1', FlowExecutionStatus.COMPLETED, 's3'),
        t('s1', FlowExecutionStatus.COMPLETED, 's4'),
      ];

      try {
        await evaluator.evaluate(ambiguous, 's1', FlowExecutionStatus.COMPLETED);
        throw new Error('expected evaluate to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidFlowGraphError);
        const e = err as InvalidFlowGraphError;
        expect(e.code).toBe('AMBIGUOUS_TRANSITION');
        expect(e.details).toEqual({
          fromStepId: 's1',
          status: FlowExecutionStatus.COMPLETED,
          count: 3,
        });
      }
    });
  });

  describe('async contract', () => {
    it('returns a Promise (uniform async API per ORACLE verdict 3c)', () => {
      const promise = evaluator.evaluate(
        [t('s1', FlowExecutionStatus.COMPLETED, 's2')],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      expect(promise).toBeInstanceOf(Promise);
    });

    it('returned Promise resolves to the expected value', async () => {
      const promise = evaluator.evaluate(
        [t('s1', FlowExecutionStatus.COMPLETED, 's2')],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      await expect(promise).resolves.toBe('s2');
    });

    it('returned Promise rejects with InvalidFlowGraphError on ambiguity', async () => {
      const promise = evaluator.evaluate(
        [
          t('s1', FlowExecutionStatus.COMPLETED, 's2'),
          t('s1', FlowExecutionStatus.COMPLETED, 's3'),
        ],
        's1',
        FlowExecutionStatus.COMPLETED,
      );
      await expect(promise).rejects.toBeInstanceOf(InvalidFlowGraphError);
    });
  });
});
