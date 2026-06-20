import type { ExecutionContext, JsonValue } from '../core';

export function readCheckpoint(
  context: ExecutionContext,
  key: string,
): Record<string, JsonValue> {
  const root = asJsonRecord(context.data);
  const value = root[key];
  return asJsonRecord(value);
}

export function readCheckpointNumber(
  context: ExecutionContext,
  key: string,
  field: string,
  fallback: number,
): number {
  const value = readCheckpoint(context, key)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readCheckpointValue<T extends JsonValue>(
  context: ExecutionContext,
  key: string,
  field: string,
  fallback: T,
): T {
  const value = readCheckpoint(context, key)[field];
  return value === undefined ? fallback : (value as T);
}

export function writeCheckpoint(
  context: ExecutionContext,
  key: string,
  state: Record<string, JsonValue>,
): ExecutionContext {
  const root = { ...asJsonRecord(context.data), [key]: state };
  context.data = root;
  return context;
}

export function asJsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}
