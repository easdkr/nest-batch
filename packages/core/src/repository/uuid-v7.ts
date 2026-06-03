import { randomBytes } from 'crypto';

/**
 * UUID v7 generator — time-sortable IDs (first 48 bits are unix time ms).
 *
 * Suitable for execution IDs (JobExecution, StepExecution) where
 * chronological ordering is useful — e.g., grouping recent runs in a
 * log dashboard or in a B-tree keyed persistence layer.
 *
 * Layout per RFC 9562 §5.7:
 *   xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 *     ^ts hi   ^ts lo  ^rand  ^rand   ^rand
 * where:
 *   - positions 0-11  = 48-bit unix-ms timestamp (sortable)
 *   - position 14     = version nibble '7'
 *   - position 19     = variant nibble ∈ {8, 9, a, b} (top 2 bits = 10)
 *   - remaining 62    = random bits from `crypto.randomBytes(10)`
 */
export class UuidV7IdGenerator {
  next(): string {
    // 48-bit timestamp in hex (12 chars) — Date.now() is bounded to ~2^41
    // today, so padStart keeps it stable-width for predictable sorting.
    const ts = Date.now().toString(16).padStart(12, '0');

    // 80 random bits (10 bytes). We use byte 0's top nibble as the
    // variant and place it explicitly in group 4; the remaining 9
    // bytes (18 hex chars) fill the rest of the random slots.
    const rand = randomBytes(10);

    // RFC 9562 §4.1 variant: top 2 bits of the variant nibble must be `10`.
    // `& 0x3f` clears the top 2 bits, then `| 0x80` sets them to `10`,
    // yielding a value in [0x80, 0xbf] whose hex first digit ∈ {8,9,a,b}.
    const variantNibble = ((((rand[0] ?? 0) & 0x3f) | 0x80).toString(16) as string)[0];

    // 18 hex chars of pure random from the remaining 9 bytes.
    const rest = rand.subarray(1).toString('hex');

    return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rest.slice(0, 3)}-${variantNibble}${rest.slice(3, 6)}-${rest.slice(6, 18)}`;
  }
}
