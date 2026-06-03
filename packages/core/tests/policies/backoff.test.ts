import { describe, it, expect } from 'vitest';
import { compileBackoff } from '../../src/policies/backoff';

describe('compileBackoff', () => {
  it('exponential: initialMs=100, default factor=2 → 100, 200, 400 across attempts 1..3', () => {
    const fn = compileBackoff({ type: 'exponential', initialMs: 100 });
    expect(fn(1)).toBe(100);
    expect(fn(2)).toBe(200);
    expect(fn(3)).toBe(400);
  });

  it('fixed: ms=50 returns 50 always', () => {
    const fn = compileBackoff({ type: 'fixed', ms: 50 });
    expect(fn(1)).toBe(50);
    expect(fn(2)).toBe(50);
    expect(fn(10)).toBe(50);
  });

  it('none: returns 0', () => {
    const fn = compileBackoff({ type: 'none' });
    expect(fn(1)).toBe(0);
    expect(fn(2)).toBe(0);
    expect(fn(99)).toBe(0);
  });
});
