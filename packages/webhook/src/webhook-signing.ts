import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signing helper for the outbound webhook envelope.
 *
 * The signature is shipped in the `X-Nest-Batch-Signature` header
 * with the Stripe-style `t=<unix>,v1=<hex>` shape:
 *
 *   X-Nest-Batch-Signature: t=1717941612,v1=4f3a2b...c1d
 *
 * Where:
 *   - `t` is the unix-seconds timestamp the receiver should use
 *     to enforce a replay window (recommended: 5 minutes).
 *   - `v1` is the lowercase hex of
 *     `HMAC_SHA256(secret, "<unix>.<raw-body>")`.
 *
 * The `<raw-body>` is the EXACT JSON-serialized request body bytes
 * (not a re-serialization). Callers must pass the same string
 * they POST — the helper does not re-serialize. This avoids the
 * classic "server signed stringified JSON, client re-stringified
 * with different key order" footgun.
 *
 * The `v1` key is the v1 contract; a future v2 may add
 * `v2=`-prefixed scheme-version constants (e.g. a SHA-512
 * variant). Receivers MUST reject unknown `vN` keys.
 *
 * Reference: `docs/RELEASE-0.2.0.md` §7.4.
 */

const SIGNATURE_HEADER = 'X-Nest-Batch-Signature';
const SIGNATURE_VERSION = 'v1';

/**
 * Compute the v1 HMAC-SHA256 signature for the given (timestamp,
 * raw body) pair.
 *
 * Returns the lowercase hex string the receiver compares against
 * the `v1=` field. The function is timing-safe on the input
 * (Node's `createHmac` is constant-time per the crypto spec), so
 * it is safe to use for verification as well.
 *
 * @param secret  The host-injected secret. Never logged, never
 *   serialized, never returned by the helper.
 * @param timestamp  The unix-seconds integer the signature is
 *   pinned to. Must be a positive integer; the helper does not
 *   validate the value (callers may pin it to `Math.floor(Date.now() / 1000)`).
 * @param rawBody  The exact JSON-serialized body bytes the
 *   request will POST. Must match the body the receiver HMACs.
 */
export function signV1(
  secret: string,
  timestamp: number,
  rawBody: string,
): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('[webhook-signing] secret must be a non-empty string');
  }
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('[webhook-signing] timestamp must be a non-negative number');
  }
  if (typeof rawBody !== 'string') {
    throw new Error('[webhook-signing] rawBody must be a string');
  }
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return hmac.digest('hex');
}

/**
 * Build the full `X-Nest-Batch-Signature` header value for the
 * given (timestamp, body) pair. The result is the literal
 * header value, e.g. `t=1717941612,v1=4f3a...`.
 */
export function buildSignatureHeader(
  secret: string,
  timestamp: number,
  rawBody: string,
): string {
  const v1 = signV1(secret, timestamp, rawBody);
  return `t=${timestamp},${SIGNATURE_VERSION}=${v1}`;
}

/**
 * Parse a `X-Nest-Batch-Signature` header value back into its
 * parts. Used by the test server to extract the `t=` and
 * `v1=` fields for byte-equality verification.
 *
 * Throws on malformed input. Does NOT verify the HMAC; the
 * caller is expected to call `verifyV1` with the original body.
 */
export interface ParsedSignature {
  readonly timestamp: number;
  readonly v1: string;
}

export function parseSignatureHeader(header: string): ParsedSignature {
  if (typeof header !== 'string' || header.length === 0) {
    throw new Error('[webhook-signing] header is empty');
  }
  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    if (part.startsWith('t=')) {
      const raw = part.slice(2);
      timestamp = Number.parseInt(raw, 10);
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error(`[webhook-signing] invalid t= value: ${raw}`);
      }
    } else if (part.startsWith(`${SIGNATURE_VERSION}=`)) {
      v1 = part.slice(SIGNATURE_VERSION.length + 1);
      if (v1.length === 0) {
        throw new Error(`[webhook-signing] empty ${SIGNATURE_VERSION}= value`);
      }
    }
  }
  if (timestamp === undefined || v1 === undefined) {
    throw new Error(
      `[webhook-signing] header missing t= or ${SIGNATURE_VERSION}= field: ${header}`,
    );
  }
  return { timestamp, v1 };
}

/**
 * Timing-safe verification of a `X-Nest-Batch-Signature` header
 * against a (secret, raw body) pair.
 *
 * Returns `true` iff the v1 HMAC matches. Uses `timingSafeEqual`
 * to prevent timing-leak attacks on the comparison.
 *
 * Note: this helper is the SYMMETRIC counterpart of `signV1`.
 * Receivers (the URL targets) call it after extracting the
 * header value via `parseSignatureHeader`. The test suite uses
 * it to assert byte-equality of the HMAC computed by the
 * observer against the HMAC computed independently with the
 * same secret + body.
 */
export function verifyV1(
  secret: string,
  timestamp: number,
  rawBody: string,
  candidateV1: string,
): boolean {
  const expected = signV1(secret, timestamp, rawBody);
  // Both `expected` and `candidateV1` are lowercase hex of the
  // same length for a given (secret, body) pair, so the equal-
  // length precondition of `timingSafeEqual` holds. Defensive
  // length check: if the candidate is the wrong length, return
  // false without invoking the constant-time compare (the
  // length itself is not a secret).
  if (candidateV1.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(candidateV1, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Compute a SHA-256 fingerprint of the secret for use in
 * dead-letter log lines. The host NEVER wants the secret (or a
 * substring of it) in a log line, but operators often want a
 * stable identifier to correlate dead-letter lines across
 * services ("all 4xx dead-letters today used secret_sha256=abc...").
 *
 * Returns the first 12 hex chars of `sha256(secret)` — enough
 * to be useful as a correlation tag, short enough that it
 * cannot be brute-forced back to the secret.
 */
export function fingerprintSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    return '<missing>';
  }
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/**
 * The literal header name. Re-exported so the test server and
 * the observer never have to repeat the magic string.
 */
export const SIGNATURE_HEADER_NAME = SIGNATURE_HEADER;
