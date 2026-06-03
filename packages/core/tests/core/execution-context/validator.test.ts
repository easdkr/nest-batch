import { describe, expect, it } from 'vitest';
import { InvalidExecutionContextError } from '../../../src/core/errors';
import { assertJsonSerializable } from '../../../src/core/execution-context/validator';

describe('assertJsonSerializable', () => {
  describe('acceptance (does not throw)', () => {
    it('accepts a flat plain object with primitives and null', () => {
      const value = { a: 1, b: 'x', c: [1, 2, 3], d: { e: null } };
      expect(() => assertJsonSerializable(value)).not.toThrow();
    });

    it('accepts null at the top level', () => {
      expect(() => assertJsonSerializable(null)).not.toThrow();
    });

    it('accepts a Date instance', () => {
      expect(() => assertJsonSerializable(new Date('2024-01-01'))).not.toThrow();
    });

    it('accepts a RegExp instance', () => {
      expect(() => assertJsonSerializable(new RegExp('foo'))).not.toThrow();
    });

    it('accepts a Date nested inside an object', () => {
      const value = { when: new Date('2024-01-01'), name: 'tick' };
      expect(() => assertJsonSerializable(value)).not.toThrow();
    });

    it('accepts a RegExp nested inside an object', () => {
      const value = { pattern: new RegExp('^foo$') };
      expect(() => assertJsonSerializable(value)).not.toThrow();
    });

    it('silently omits undefined values inside objects (no throw)', () => {
      const value: Record<string, unknown> = { a: 1, b: undefined, c: 'kept' };
      expect(() => assertJsonSerializable(value)).not.toThrow();
    });

    it('silently omits undefined values inside arrays of objects', () => {
      const value = [{ a: 1, b: undefined }];
      expect(() => assertJsonSerializable(value)).not.toThrow();
    });

    it('accepts an empty object', () => {
      expect(() => assertJsonSerializable({})).not.toThrow();
    });

    it('accepts an empty array', () => {
      expect(() => assertJsonSerializable([])).not.toThrow();
    });
  });

  describe('rejection — top-level', () => {
    it('rejects a top-level function and reports path "$"', () => {
      try {
        assertJsonSerializable((): number => 1);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        expect((err as InvalidExecutionContextError).code).toBe('INVALID_EXECUTION_CONTEXT');
        const details = (err as InvalidExecutionContextError).details as { path: string };
        expect(details.path).toBe('$');
      }
    });

    it('rejects undefined at the top level', () => {
      expect(() => assertJsonSerializable(undefined)).toThrow(InvalidExecutionContextError);
    });

    it('rejects NaN at the top level', () => {
      expect(() => assertJsonSerializable(NaN)).toThrow(InvalidExecutionContextError);
    });

    it('rejects Infinity at the top level', () => {
      expect(() => assertJsonSerializable(Infinity)).toThrow(InvalidExecutionContextError);
    });

    it('rejects -Infinity at the top level', () => {
      expect(() => assertJsonSerializable(-Infinity)).toThrow(InvalidExecutionContextError);
    });

    it('rejects a BigInt at the top level', () => {
      try {
        assertJsonSerializable(BigInt(1));
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        const details = (err as InvalidExecutionContextError).details as { path: string };
        expect(details.path).toBe('$');
      }
    });

    it('rejects a Symbol at the top level', () => {
      expect(() => assertJsonSerializable(Symbol('x'))).toThrow(InvalidExecutionContextError);
    });

    it('rejects a class instance at the top level', () => {
      class Foo {
        public x = 1;
      }
      try {
        assertJsonSerializable(new Foo());
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        const details = (err as InvalidExecutionContextError).details as {
          path: string;
          ctor: string;
        };
        expect(details.path).toBe('$');
        expect(details.ctor).toBe('Foo');
      }
    });
  });

  describe('rejection — nested', () => {
    it('rejects a nested function and reports the dotted path "$.fn"', () => {
      const value: Record<string, unknown> = { fn: (): number => 1 };
      try {
        assertJsonSerializable(value);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        const details = (err as InvalidExecutionContextError).details as { path: string };
        expect(details.path).toBe('$.fn');
      }
    });

    it('rejects a function inside an array with indexed path', () => {
      const value: unknown[] = [1, 2, (): number => 3];
      try {
        assertJsonSerializable(value);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        const details = (err as InvalidExecutionContextError).details as { path: string };
        expect(details.path).toBe('$[2]');
      }
    });

    it('rejects a BigInt inside a nested object with the dotted path', () => {
      const value = { payload: { count: BigInt(10) } };
      try {
        assertJsonSerializable(value);
        throw new Error('expected to throw');
      } catch (err) {
        const details = (err as InvalidExecutionContextError).details as { path: string };
        expect(details.path).toBe('$.payload.count');
      }
    });

    it('rejects a Symbol nested in an object', () => {
      expect(() => assertJsonSerializable({ s: Symbol('x') })).toThrow(
        InvalidExecutionContextError,
      );
    });

    it('rejects NaN nested in an object', () => {
      expect(() => assertJsonSerializable({ n: NaN })).toThrow(InvalidExecutionContextError);
    });

    it('rejects a class instance nested in an object', () => {
      class Bar {
        public y = 'hello';
      }
      const value = { inner: { item: new Bar() } };
      try {
        assertJsonSerializable(value);
        throw new Error('expected to throw');
      } catch (err) {
        const details = (err as InvalidExecutionContextError).details as {
          path: string;
          ctor: string;
        };
        expect(details.path).toBe('$.inner.item');
        expect(details.ctor).toBe('Bar');
      }
    });
  });

  describe('rejection — circular references', () => {
    it('rejects a self-referencing object', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      try {
        assertJsonSerializable(obj);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/Circular reference/);
      }
    });

    it('rejects a two-node circular reference', () => {
      const a: Record<string, unknown> = { name: 'a' };
      const b: Record<string, unknown> = { name: 'b', back: a };
      a.back = b;
      try {
        assertJsonSerializable(a);
        throw new Error('expected to throw');
      } catch (err) {
        expect((err as Error).message).toMatch(/Circular reference/);
      }
    });
  });

  describe('rejection — depth', () => {
    it('rejects objects nested deeper than MAX_DEPTH (100)', () => {
      type Nested = { next?: Nested };
      const build = (depth: number): Nested => {
        if (depth === 0) return {};
        return { next: build(depth - 1) };
      };
      const value = build(150);
      try {
        assertJsonSerializable(value);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidExecutionContextError);
        expect((err as Error).message).toMatch(/Max depth exceeded/);
      }
    });

    it('rejects arrays nested deeper than MAX_DEPTH (100)', () => {
      type Nested = unknown[] | Nested[];
      const build = (depth: number): Nested => {
        if (depth === 0) return [];
        return [build(depth - 1)];
      };
      const value = build(150);
      expect(() => assertJsonSerializable(value)).toThrow(/Max depth exceeded/);
    });
  });
});
