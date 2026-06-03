import { describe, expect, test } from 'vitest';
import { UuidV7IdGenerator } from '../../src/repository/uuid-v7';

describe('UuidV7IdGenerator', () => {
  // -------------------------------------------------------------------------
  // 1) Monotonic / time-sortable: 5 IDs generated with small delays must
  //    sort lexically in the same order as they were produced. This is the
  //    property that makes UUID v7 useful for execution IDs.
  // -------------------------------------------------------------------------
  test('1) produces IDs in monotonically increasing (time-sortable) order', async () => {
    const gen = new UuidV7IdGenerator();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(gen.next());
      // 2 ms between calls — Date.now() is millisecond-resolution but
      // a small delay makes the timestamp component advance even on
      // very fast hosts (where two calls in the same ms would still
      // happen to be lexically tied — that's a documented property of
      // v7, not a failure).
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  // -------------------------------------------------------------------------
  // 2) Format: 36 chars, four hyphens at the canonical positions, version
  //    nibble = '7', and overall matches the UUID 8-4-4-4-12 layout.
  // -------------------------------------------------------------------------
  test('2) next() returns a 36-char UUID with the canonical format', () => {
    const gen = new UuidV7IdGenerator();
    const id = gen.next();

    expect(id).toHaveLength(36);
    expect(id[8]).toBe('-');
    expect(id[13]).toBe('-');
    expect(id[18]).toBe('-');
    expect(id[23]).toBe('-');

    const stripped = id.replace(/-/g, '');
    expect(stripped).toHaveLength(32);
    expect(stripped).toMatch(/^[0-9a-f]{32}$/);

    // Version nibble (position 14, just after the second hyphen) = '7'.
    expect(id[14]).toBe('7');

    // Variant nibble (position 19) ∈ {8, 9, a, b} per RFC 9562 §4.1.
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
});
