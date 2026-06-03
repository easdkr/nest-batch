import { InvalidExecutionContextError } from '../errors';
import type { JsonValue } from './json-value';

const MAX_DEPTH = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Asserts that `value` is JSON-serializable. Throws InvalidExecutionContextError
 * with `details.path` on the first non-serializable value encountered.
 *
 * Rejection rules:
 *   - undefined (top level only; inside objects/arrays: silently omitted)
 *   - function, bigint, symbol
 *   - non-finite numbers (NaN, Infinity, -Infinity)
 *   - class instances (anything with a non-Object prototype that is not Date/RegExp)
 *   - circular references
 *   - nesting depth > 100
 *
 * `seen` and `depth` are threaded through recursive calls so cycles and depth
 * are tracked across the whole object graph, not per call.
 */
export function assertJsonSerializable(
  value: unknown,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  if (value === null) return;

  const t = typeof value;
  if (t === 'undefined') {
    throw new InvalidExecutionContextError(
      `Value at ${path} is undefined (must be omitted or null)`,
      { path },
    );
  }
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new InvalidExecutionContextError(
        `Value at ${path} is not a finite number`,
        { path, value },
      );
    }
    return;
  }
  if (t === 'bigint') {
    throw new InvalidExecutionContextError(`Value at ${path} is a BigInt`, { path });
  }
  if (t === 'symbol') {
    throw new InvalidExecutionContextError(`Value at ${path} is a Symbol`, { path });
  }
  if (t === 'function') {
    throw new InvalidExecutionContextError(`Value at ${path} is a function`, { path });
  }

  // object types
  if (value instanceof Date) return;
  if (value instanceof RegExp) return;

  if (depth > MAX_DEPTH) {
    throw new InvalidExecutionContextError(`Max depth exceeded at ${path}`, { path });
  }
  const objRef = value as object;
  if (seen.has(objRef)) {
    throw new InvalidExecutionContextError(
      `Circular reference detected at ${path}`,
      { path },
    );
  }
  seen.add(objRef);

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      assertJsonSerializable(arr[i], `${path}[${i}]`, seen, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    const obj = value;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === undefined) continue; // undefined values in objects are silently omitted
      assertJsonSerializable(v, `${path}.${key}`, seen, depth + 1);
    }
    return;
  }
  // class instance
  throw new InvalidExecutionContextError(
    `Value at ${path} is a class instance (not plain object)`,
    { path, ctor: (value as object).constructor?.name },
  );
}

// Re-export JsonValue for downstream convenience.
export type { JsonValue } from './json-value';
