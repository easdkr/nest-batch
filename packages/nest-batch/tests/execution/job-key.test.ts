import { describe, it, test, expect } from 'vitest';
import { canonicalJobKey } from '../../src/execution/job-key';

/**
 * Unit tests for canonicalJobKey.
 *
 * These are pure-function tests of the canonicalization + hashing, isolated
 * from the JobLauncher. The launcher-level test (job-launcher.test.ts) proves
 * the same properties transitively (same JobInstance.id for re-ordered params);
 * these tests pin the hash shape and the canonicalization contract directly.
 */
describe('canonicalJobKey', () => {
  it('returns a 64-char sha256 hex digest', () => {
    const key = canonicalJobKey({ a: 1 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable — same params always produce the same key', () => {
    expect(canonicalJobKey({ a: 1, b: 'x' })).toBe(canonicalJobKey({ a: 1, b: 'x' }));
  });

  it('ignores object key order at the top level', () => {
    expect(canonicalJobKey({ a: 1, b: 2 })).toBe(canonicalJobKey({ b: 2, a: 1 }));
  });

  it('ignores object key order recursively (nested objects)', () => {
    expect(canonicalJobKey({ outer: { z: 3, a: 1, m: 2 } })).toBe(
      canonicalJobKey({ outer: { a: 1, m: 2, z: 3 } }),
    );
  });

  it('treats null and undefined as omitted (same key as without the field)', () => {
    const withNull = canonicalJobKey({ a: 1, b: null as unknown as never });
    const withUndef = canonicalJobKey({ a: 1, b: undefined as unknown as never });
    const without = canonicalJobKey({ a: 1 });
    expect(withNull).toBe(without);
    expect(withUndef).toBe(without);
  });

  it('preserves array order (different order → different key)', () => {
    const a = canonicalJobKey({ items: [1, 2, 3] });
    const b = canonicalJobKey({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it('canonicalizes Date to ISO string (timezone-independent)', () => {
    const d = new Date('2024-01-02T03:04:05.000Z');
    // JobParameters is `Record<string, JsonValue>` which excludes Date by
    // type; we cast through `unknown` because the canonicalizer explicitly
    // supports Date at runtime (per the job-key docblock).
    const paramsWithDate1 = { at: d } as unknown as { at: Date };
    const paramsWithDate2 = { at: new Date(d.getTime()) } as unknown as { at: Date };
    expect(canonicalJobKey(paramsWithDate1 as never)).toBe(
      canonicalJobKey(paramsWithDate2 as never),
    );
    // Date and its ISO string produce the same key
    expect(canonicalJobKey(paramsWithDate1 as never)).toBe(
      canonicalJobKey({ at: '2024-01-02T03:04:05.000Z' }),
    );
  });

  it('empty params produce a stable, fixed hash', () => {
    // sha256("{}") = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(canonicalJobKey({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('different values produce different keys', () => {
    expect(canonicalJobKey({ a: 1 })).not.toBe(canonicalJobKey({ a: 2 }));
    expect(canonicalJobKey({ a: '1' })).not.toBe(canonicalJobKey({ a: 1 }));
  });

  it('throws on BigInt values (unsupported in JSON)', () => {
    expect(() => canonicalJobKey({ a: 10n } as unknown as never)).toThrow(/BigInt/);
  });
});

/**
 * Edge-case verification tests (Task 36) — re-pins the canonicalization
 * contract from the ORACLE verdict 3b and Metris "Re-running COMPLETED job
 * with same params / Launching same job+params concurrently" requirements:
 *   - Object key order independence (top-level AND nested)
 *   - Date → ISO string normalization
 *   - null/undefined omission
 *   - Empty params stability
 *   - BigInt rejection
 */
describe('canonicalJobKey - edge cases', () => {
  test('Object key order independence at TOP level', () => {
    const a = canonicalJobKey({ a: 1, b: 2 });
    const b = canonicalJobKey({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test('Object key order independence at NESTED level', () => {
    const a = canonicalJobKey({ outer: { a: 1, b: 2 } });
    const b = canonicalJobKey({ outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  test('Different order in nested array produces different hash', () => {
    const a = canonicalJobKey({ items: [1, 2, 3] });
    const b = canonicalJobKey({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  test('null param is omitted from key', () => {
    const a = canonicalJobKey({ x: 1, y: null });
    const b = canonicalJobKey({ x: 1 });
    expect(a).toBe(b);
  });

  test('Date param serializes to ISO string', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const k = canonicalJobKey({ date } as unknown as never);
    // Should be 64-char hex (sha256)
    expect(k).toMatch(/^[a-f0-9]{64}$/);
    // Same date → same key
    const k2 = canonicalJobKey({ date: new Date('2024-01-01T00:00:00.000Z') } as unknown as never);
    expect(k).toBe(k2);
    // Different date → different key
    const k3 = canonicalJobKey({ date: new Date('2024-01-02T00:00:00.000Z') } as unknown as never);
    expect(k).not.toBe(k3);
  });

  test('undefined value is omitted', () => {
    const a = canonicalJobKey({ x: 1, y: undefined } as unknown as never);
    const b = canonicalJobKey({ x: 1 });
    expect(a).toBe(b);
  });

  test('empty params {} produces consistent hash', () => {
    const a = canonicalJobKey({});
    const b = canonicalJobKey({});
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('BigInt throws (cannot be JSON-serialized)', () => {
    expect(() => canonicalJobKey({ x: 1n } as unknown as never)).toThrow();
  });
});
