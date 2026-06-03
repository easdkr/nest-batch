import { createHash } from 'crypto';
import type { JobParameters } from '../core/repository/types';

/**
 * Canonicalize JobParameters into a stable string.
 * - Object keys sorted alphabetically (recursive)
 * - Arrays preserve order (different order = different key)
 * - Date → ISO string
 * - null/undefined → omitted
 * - Number: keep as-is (1 vs 1.0 same via String())
 * - String: as-is (no whitespace trim — callers must normalize)
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') throw new Error('BigInt not supported in job key');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = canonicalize(obj[k]);
      if (v !== undefined) sorted[k] = v;
    }
    return sorted;
  }
  return value;
}

export function canonicalJobKey(params: JobParameters): string {
  const canonical = canonicalize(params);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
