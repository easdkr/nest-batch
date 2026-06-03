import { describe, it, expect } from 'vitest';

import {
  compileSkipPolicy,
  type SkipContext,
} from '../../src/policies/skip-policy';
import { InvalidFlowGraphError } from '../../src/core/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class ValidationError extends Error {
  code = 'VALIDATION';
}
class OtherError extends Error {
  code = 'OTHER';
}
class CustomCodedError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

const baseCtx: SkipContext = {
  item: null,
  phase: 'process',
  skipCount: 0,
  skipLimit: 3,
};

describe('compileSkipPolicy', () => {
  it('skips on class match and does not skip on unrelated class', () => {
    const policy = compileSkipPolicy({
      limit: 3,
      skippable: [ValidationError],
    });

    expect(
      policy.shouldSkip(new ValidationError('bad input'), baseCtx),
    ).toBe(true);
    expect(policy.shouldSkip(new OtherError('boom'), baseCtx)).toBe(false);
    expect(policy.shouldSkip(new TypeError('not assignable'), baseCtx)).toBe(
      false,
    );
  });

  it('matches custom errors via predicate function', () => {
    const policy = compileSkipPolicy({
      limit: 5,
      skippable: [
        (err) =>
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: unknown }).code === 'TEMP',
      ],
    });

    expect(
      policy.shouldSkip(new CustomCodedError('TEMP', 'flaky'), {
        ...baseCtx,
        skipLimit: 5,
      }),
    ).toBe(true);
    expect(
      policy.shouldSkip(new CustomCodedError('PERM', 'hard fail'), {
        ...baseCtx,
        skipLimit: 5,
      }),
    ).toBe(false);
    // Non-Error payloads should not crash the predicate.
    expect(
      policy.shouldSkip({ code: 'TEMP' }, { ...baseCtx, skipLimit: 5 }),
    ).toBe(true);
  });

  it('returns false once skipCount reaches skipLimit', () => {
    const policy = compileSkipPolicy({
      limit: 3,
      skippable: [ValidationError],
    });

    // 0 of 3 used → still allowed
    expect(
      policy.shouldSkip(new ValidationError('x'), {
        ...baseCtx,
        skipCount: 0,
        skipLimit: 3,
      }),
    ).toBe(true);
    // 2 of 3 used → still allowed
    expect(
      policy.shouldSkip(new ValidationError('x'), {
        ...baseCtx,
        skipCount: 2,
        skipLimit: 3,
      }),
    ).toBe(true);
    // 3 of 3 used → quota exhausted
    expect(
      policy.shouldSkip(new ValidationError('x'), {
        ...baseCtx,
        skipCount: 3,
        skipLimit: 3,
      }),
    ).toBe(false);
    // 5 of 3 used (over) → still rejected
    expect(
      policy.shouldSkip(new ValidationError('x'), {
        ...baseCtx,
        skipCount: 5,
        skipLimit: 3,
      }),
    ).toBe(false);
  });

  it('throws InvalidFlowGraphError(INVALID_SKIP_LIMIT) when limit is 0', () => {
    expect(() => compileSkipPolicy({ limit: 0, skippable: [ValidationError] }))
      .toThrowError(InvalidFlowGraphError);
    try {
      compileSkipPolicy({ limit: 0, skippable: [ValidationError] });
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFlowGraphError);
      expect((err as InvalidFlowGraphError).code).toBe('INVALID_SKIP_LIMIT');
      expect((err as InvalidFlowGraphError).message).toMatch(/> 0/);
    }
  });

  it('supports mixing class-based and predicate-based skippable entries', () => {
    const policy = compileSkipPolicy({
      limit: 4,
      skippable: [
        ValidationError,
        (err) =>
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: unknown }).code === 'TEMP',
      ],
    });

    // class branch
    expect(policy.shouldSkip(new ValidationError('x'), baseCtx)).toBe(true);
    // predicate branch
    expect(
      policy.shouldSkip(new CustomCodedError('TEMP'), {
        ...baseCtx,
        skipLimit: 4,
      }),
    ).toBe(true);
    // neither branch
    expect(
      policy.shouldSkip(new CustomCodedError('PERM'), {
        ...baseCtx,
        skipLimit: 4,
      }),
    ).toBe(false);
  });

  it('throws InvalidFlowGraphError(INVALID_SKIP_LIMIT) when limit is negative', () => {
    expect(() =>
      compileSkipPolicy({ limit: -1, skippable: [ValidationError] }),
    ).toThrowError(InvalidFlowGraphError);
    try {
      compileSkipPolicy({ limit: -1, skippable: [ValidationError] });
    } catch (err) {
      expect((err as InvalidFlowGraphError).code).toBe('INVALID_SKIP_LIMIT');
      expect((err as InvalidFlowGraphError).details).toEqual({ limit: -1 });
    }
  });
});
