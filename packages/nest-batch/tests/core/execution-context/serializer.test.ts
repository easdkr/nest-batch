import { describe, expect, it } from 'vitest';
import { InvalidExecutionContextError } from '../../../src/core/errors';
import {
  deserializeContext,
  serializeContext,
} from '../../../src/core/execution-context/serializer';
import type { JsonValue } from '../../../src/core/execution-context/json-value';

describe('serializeContext + deserializeContext roundtrip', () => {
  it('roundtrips a flat object with mixed primitives', () => {
    const value = { a: 1, b: [1, 2, 3] } as const;
    const raw = serializeContext(value);
    const back = deserializeContext<JsonValue>(raw);
    expect(back).toEqual(value);
  });

  it('roundtrips a deeply nested object', () => {
    const value = {
      job: 'import-products',
      params: { runId: 'abc-123', retries: 3, flags: { dryRun: true, notify: false } },
      history: [
        { step: 'validate', ok: true, count: 100 },
        { step: 'write', ok: true, count: 100 },
      ],
    };
    const raw = serializeContext(value);
    const back = deserializeContext<JsonValue>(raw);
    expect(back).toEqual(value);
  });

  it('roundtrips arrays and preserves element order', () => {
    const value = ['first', 'second', 'third', 4, { fifth: 5 }];
    const raw = serializeContext(value);
    const back = deserializeContext<JsonValue>(raw);
    expect(back).toEqual(value);
    expect((back as unknown[])[0]).toBe('first');
    expect((back as unknown[])[4]).toEqual({ fifth: 5 });
  });

  it('roundtrips null and primitive values', () => {
    const cases: unknown[] = [null, 'string', 42, true, false, 0, ''];
    for (const value of cases) {
      const raw = serializeContext(value);
      const back = deserializeContext<JsonValue>(raw);
      expect(back).toEqual(value);
    }
  });

  it('serializeContext produces a JSON string', () => {
    const raw = serializeContext({ a: 1 });
    expect(typeof raw).toBe('string');
    expect(raw).toBe('{"a":1}');
  });

  it('serializeContext omits undefined values in objects (matches JSON.stringify semantics)', () => {
    const value: Record<string, unknown> = { a: 1, b: undefined, c: 'kept' };
    const raw = serializeContext(value);
    expect(raw).toBe('{"a":1,"c":"kept"}');
  });

  it('deserializeContext parses a JSON string into the expected shape', () => {
    const back = deserializeContext<{ a: number }>('{"a":1}');
    expect(back).toEqual({ a: 1 });
    expect(back.a).toBe(1);
  });

  it('deserializeContext throws on invalid JSON', () => {
    expect(() => deserializeContext('{ not valid json')).toThrow(SyntaxError);
  });

  it('serializeContext throws on BigInt in object', () => {
    expect(() => serializeContext({ count: BigInt(10) })).toThrow(InvalidExecutionContextError);
  });

  it('serializeContext throws InvalidExecutionContextError (not plain JSON.stringify error) on BigInt', () => {
    try {
      serializeContext({ count: BigInt(10) });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidExecutionContextError);
      expect((err as InvalidExecutionContextError).code).toBe('INVALID_EXECUTION_CONTEXT');
    }
  });

  it('serializeContext throws on top-level BigInt', () => {
    expect(() => serializeContext(BigInt(1))).toThrow(InvalidExecutionContextError);
  });

  it('roundtrip preserves unicode, escaped strings, and numeric edge cases', () => {
    const value = {
      emoji: '🚀',
      escaped: 'line1\nline2\t"quoted"',
      negatives: -42,
      floats: 3.14159,
      zeros: 0,
    };
    const raw = serializeContext(value);
    const back = deserializeContext<JsonValue>(raw);
    expect(back).toEqual(value);
  });
});
