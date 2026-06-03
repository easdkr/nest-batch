import { InvalidExecutionContextError } from '../errors';
import type { JsonValue } from './json-value';

export function serializeContext(ctx: unknown): string {
  return JSON.stringify(
    ctx,
    function (this: unknown, key: string, value: unknown): unknown {
      if (typeof value === 'bigint') {
        throw new InvalidExecutionContextError(
          `Cannot serialize BigInt at key "${key}"`,
          { key },
        );
      }
      return value;
    },
  );
}

export function deserializeContext<T extends JsonValue>(raw: string): T {
  return JSON.parse(raw) as T;
}
