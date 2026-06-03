import { describe, it, expect } from 'vitest';
import {
  compileRetryPolicy,
  type RetryContext,
} from '../../src/policies/retry-policy';
import type { RetryPolicyConfig } from '../../src/core/ir/policy-config';

class RetryableError extends Error {
  code = 'RETRYABLE';
}

class NonRetryableError extends Error {
  code = 'NON_RETRYABLE';
}

function baseConfig(overrides: Partial<RetryPolicyConfig> = {}): RetryPolicyConfig {
  return {
    limit: 3,
    retryable: [RetryableError],
    backoff: { type: 'none' },
    ...overrides,
  };
}

function baseContext(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    item: null,
    phase: 'process',
    attempt: 1,
    retryLimit: 3,
    ...overrides,
  };
}

describe('compileRetryPolicy', () => {
  it('canRetry returns true for matching error within limit (attempt=1, limit=3, error matches)', () => {
    const policy = compileRetryPolicy(baseConfig());
    const ctx = baseContext({ attempt: 1, retryLimit: 3 });
    expect(policy.canRetry(new RetryableError('boom'), ctx)).toBe(true);
  });

  it('canRetry returns false when attempt > limit', () => {
    const policy = compileRetryPolicy(baseConfig());
    const ctx = baseContext({ attempt: 4, retryLimit: 3 });
    expect(policy.canRetry(new RetryableError('boom'), ctx)).toBe(false);
  });

  it('exponential backoff: initialMs=100, factor=2 → 100, 200, 400, 800', () => {
    const policy = compileRetryPolicy(
      baseConfig({ backoff: { type: 'exponential', initialMs: 100, factor: 2 } }),
    );
    expect(policy.backoffMs(1)).toBe(100);
    expect(policy.backoffMs(2)).toBe(200);
    expect(policy.backoffMs(3)).toBe(400);
    expect(policy.backoffMs(4)).toBe(800);
  });

  it('exponential backoff with maxMs cap: 100, 200, 300, 300 (capped)', () => {
    const policy = compileRetryPolicy(
      baseConfig({ backoff: { type: 'exponential', initialMs: 100, factor: 2, maxMs: 300 } }),
    );
    expect(policy.backoffMs(1)).toBe(100);
    expect(policy.backoffMs(2)).toBe(200);
    expect(policy.backoffMs(3)).toBe(300);
    expect(policy.backoffMs(4)).toBe(300);
  });

  it('fixed backoff: same ms each attempt', () => {
    const policy = compileRetryPolicy(baseConfig({ backoff: { type: 'fixed', ms: 250 } }));
    expect(policy.backoffMs(1)).toBe(250);
    expect(policy.backoffMs(2)).toBe(250);
    expect(policy.backoffMs(3)).toBe(250);
    expect(policy.backoffMs(4)).toBe(250);
  });

  it('backoff: { type: "none" } returns 0', () => {
    const policy = compileRetryPolicy(baseConfig({ backoff: { type: 'none' } }));
    expect(policy.backoffMs(1)).toBe(0);
    expect(policy.backoffMs(2)).toBe(0);
    expect(policy.backoffMs(3)).toBe(0);
  });

  it('predicate function matches custom errors', () => {
    const isHttpTimeout = (err: unknown): boolean =>
      err instanceof Error && err.message.startsWith('TIMEOUT');
    const policy = compileRetryPolicy(
      baseConfig({ retryable: [isHttpTimeout] }),
    );
    const ctx = baseContext();

    expect(policy.canRetry(new Error('TIMEOUT: read failed'), ctx)).toBe(true);
    expect(policy.canRetry(new Error('ECONNREFUSED'), ctx)).toBe(false);
    expect(policy.canRetry(new NonRetryableError('other'), ctx)).toBe(false);
  });

  it('limit: 0 throws', () => {
    expect(() => compileRetryPolicy(baseConfig({ limit: 0 }))).toThrow(
      /limit must be > 0/,
    );
  });
});
