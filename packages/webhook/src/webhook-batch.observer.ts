import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BATCH_EVENT,
  type BatchEvent,
  type BatchEventType,
  type BatchObserver,
} from '@nest-batch/core';

import {
  DEFAULT_WEBHOOK_RETRY_DELAYS_MS,
  FAST_WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_MODULE_OPTIONS,
  type ResolvedWebhookOptions,
  type WebhookLogger,
} from './module-options';
import {
  SIGNATURE_HEADER_NAME,
  buildSignatureHeader,
  fingerprintSecret,
} from './webhook-signing';

/**
 * `WebhookBatchObserver` — the v1 webhook delivery observer.
 *
 * Implements `BatchObserver` from `@nest-batch/core`. On every
 * subscribed `BATCH_EVENT.*` (default:
 * `[JOB_COMPLETED, JOB_FAILED, STEP_FAILED]`) the observer:
 *
 *   1. Serializes a normalized JSON envelope
 *      `{ version: 1, type, timestamp, jobId, execution }`.
 *   2. Computes the v1 HMAC-SHA256 signature over
 *      `<unix>.<raw-body>` (Stripe-style).
 *   3. POSTs the envelope + `X-Nest-Batch-Signature` header to
 *      every URL in `urls`.
 *   4. Retries on 5xx and network errors through the fixed
 *      4-attempt budget at `[1s, 5s, 25s, 125s]`. HTTP 4xx
 *      responses are NOT retried (client error, won't change).
 *   5. On final failure, emits a `logger.warn` dead-letter line
 *      including the URL, attempt count, last status / error,
 *      and a SHA-256 fingerprint of the secret (NEVER the
 *      secret itself).
 *
 * The observer is the v1 contract documented in
 * `docs/RELEASE-0.2.0.md` §7 and pinned by T-AC-5
 * (`packages/webhook/tests/webhook-observer.test.ts`).
 */
@Injectable()
export class WebhookBatchObserver implements BatchObserver {
  private readonly logger: WebhookLogger;

  /** Resolved + frozen options. The secret lives here and nowhere else. */
  private readonly options: ResolvedWebhookOptions;

  /**
   * Cached lookup of the subscription set. Built once at
   * construction time so `onEvent` is a single `Set.has` check.
   */
  private readonly subscribed: ReadonlySet<BatchEventType>;

  /**
   * Test-only override for the retry schedule. When
   * `process.env.WEBHOOK_TEST_FAST === '1'`, the schedule is
   * `[1ms, 5ms, 25ms, 125ms]` so the suite can exercise the
   * 4-attempt path without waiting 156 seconds. The override
   * is gated behind an env var so production cannot trip it
   * by accident.
   */
  private readonly retryDelaysMs: readonly number[];

  /**
   * Sentinel subscriber set: defaults to
   * `[JOB_COMPLETED, JOB_FAILED, STEP_FAILED]`. Overridable via
   * the `events` option in `forRoot({...})`.
   */
  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS) options: ResolvedWebhookOptions,
  ) {
    this.options = options;
    this.logger = options.logger ?? new Logger(WebhookBatchObserver.name);
    this.subscribed = new Set(options.events);
    this.retryDelaysMs =
      process.env['WEBHOOK_TEST_FAST'] === '1'
        ? FAST_WEBHOOK_RETRY_DELAYS_MS
        : DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
  }

  /**
   * `BatchObserver` entry point. Filters by the subscription
   * set, then dispatches to every URL. NEVER throws — a slow /
   * failing observer must not poison the executor (the
   * JobExecutor already swallows observer errors, but we are
   * defensive in depth).
   */
  async onEvent(event: BatchEvent): Promise<void> {
    if (!this.subscribed.has(event.type)) return;
    if (this.options.urls.length === 0) return;
    try {
      await this.deliverToAll(event);
    } catch (err) {
      // Defence in depth: the JobExecutor already swallows
      // observer errors, but we re-assert it here so a single
      // failing URL cannot starve the rest. The per-URL
      // delivery loop has its own try/catch and writes a
      // dead-letter `warn` for fully-failed URLs, so this
      // outer catch only fires for genuinely unexpected
      // errors (e.g. a synchronous throw in the envelope
      // builder). The secret is NEVER included in this
      // message.
      this.logger.warn(
        `unexpected observer error type=${event.type} ` +
          `jobExecutionId=${event.jobExecutionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------------

  /**
   * Build the envelope once, then POST to every URL in
   * `urls` in parallel. A single URL's retry exhaustion does
   * not affect the other URLs — each URL has its own
   * `deliverToUrl` invocation and its own dead-letter line.
   *
   * The envelope is built with `JSON.stringify` (NOT a Nest
   * serializer) so the bytes are stable and match the HMAC
   * input byte-for-byte. The body string is the literal
   * argument to `fetch`, so the receiver sees the same
   * bytes the observer signed.
   */
  private async deliverToAll(event: BatchEvent): Promise<void> {
    const envelope = this.buildEnvelope(event);
    const body = JSON.stringify(envelope);
    await Promise.all(
      this.options.urls.map((url) => this.deliverToUrl(url, event, body)),
    );
  }

  /**
   * Build the v1 envelope payload. The shape is the contract
   * the receiver expects; changing it is a breaking change.
   *
   *   - `version: 1` — the envelope schema version (the
   *     `v1=` in the signature header is the SIGNATURE
   *     version, not the ENVELOPE version; they are
   *     independent).
   *   - `type` — the `BatchEvent.type` string verbatim
   *     (e.g. `nest-batch.job.completed`).
   *   - `timestamp` — the event's `Date` serialized as
   *     ISO-8601 (the original `Date` is not JSON-safe).
   *   - `jobId` — the `jobExecutionId` (the `BatchEvent`
   *     contract guarantees this is always set).
   *   - `execution` — the `JobExecution` shape derived from
   *     the event's `data` payload. The observer treats
   *     `data` as opaque `JsonValue` and passes it through
   *     after a defensive deep-copy via `structuredClone`
   *     so the observer cannot mutate the executor's
   *     internal state by reference.
   *   - `stepId` — present for STEP\_\* / CHUNK\_\* / ITEM\_\*
   *     events; absent for JOB\_\* events. Mirrors the
   *     `BatchEvent.stepExecutionId` contract.
   */
  private buildEnvelope(event: BatchEvent): WebhookEnvelope {
    return {
      version: 1,
      type: event.type,
      timestamp: event.timestamp.toISOString(),
      jobId: event.jobExecutionId,
      ...(event.stepExecutionId !== undefined
        ? { stepId: event.stepExecutionId }
        : {}),
      execution: cloneJson(event.data),
    };
  }

  // -----------------------------------------------------------------------
  // Per-URL delivery with retry
  // -----------------------------------------------------------------------

  /**
   * POST the envelope to one URL with the full retry budget.
   * Stops on the first 2xx; retries on 5xx and network errors;
   * does NOT retry on 4xx; emits a dead-letter `warn` on
   * exhaustion. The body is signed once; the same signed body
   * is sent on every attempt.
   */
  private async deliverToUrl(
    url: string,
    event: BatchEvent,
    body: string,
  ): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildSignatureHeader(
      this.options.secret,
      timestamp,
      body,
    );
    const fingerprint = fingerprintSecret(this.options.secret);

    const totalAttempts = this.options.attempts;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const result = await this.attemptOnce(url, body, signature, timestamp);
      if (result.kind === 'success') {
        if (attempt > 1) {
          this.logger.log(
            `delivered url=${url} type=${event.type} ` +
              `jobExecutionId=${event.jobExecutionId} attempt=${attempt}/${totalAttempts} ` +
              `status=${result.status} (after retry)`,
          );
        } else {
          this.logger.debug(
            `delivered url=${url} type=${event.type} ` +
              `jobExecutionId=${event.jobExecutionId} attempt=${attempt}/${totalAttempts} ` +
              `status=${result.status}`,
          );
        }
        return;
      }
      if (result.kind === 'client-error') {
        // 4xx — NO retry. Log at `warn` and return. The host
        // is expected to fix the misconfiguration (bad URL,
        // missing auth, malformed payload). The signature
        // fingerprint and the attempt count are included so
        // the host can correlate with the receiver's logs.
        this.logger.warn(
          `[WebhookBatchObserver] dead-letter url=${url} attempts=${attempt} ` +
            `lastStatus=${result.status} lastError=HTTP ${result.status} ` +
            `type=${event.type} jobExecutionId=${event.jobExecutionId} ` +
            `secret_sha256=${fingerprint}`,
        );
        return;
      }
      // result.kind === 'server-error' | 'network-error'
      lastStatus = result.kind === 'server-error' ? result.status : undefined;
      lastError = result.kind === 'server-error'
        ? `HTTP ${result.status}`
        : result.error;

      if (attempt < totalAttempts) {
        // The retry schedule has exactly `attempts - 1`
        // entries (delays BETWEEN attempts). When attempts
        // is < 4 (test override), the array is sliced to
        // match — we do not extend the schedule.
        const delayIndex = Math.min(attempt - 1, this.retryDelaysMs.length - 1);
        const delayMs = this.retryDelaysMs[delayIndex] ?? 0;
        this.logger.debug(
          `retry url=${url} attempt=${attempt}/${totalAttempts} ` +
            `status=${lastStatus ?? 'n/a'} lastError=${lastError} ` +
            `nextDelayMs=${delayMs}`,
        );
        await sleep(delayMs);
      }
    }

    // Final failure — log dead-letter. NEVER include the
    // secret. The fingerprint is a SHA-256 prefix (12 hex
    // chars) that operators can use to correlate dead-letters
    // across services without exposing the secret.
    this.logger.warn(
      `[WebhookBatchObserver] dead-letter url=${url} attempts=${totalAttempts} ` +
        `lastStatus=${lastStatus ?? 'n/a'} lastError=${lastError ?? 'n/a'} ` +
        `type=${event.type} jobExecutionId=${event.jobExecutionId} ` +
        `secret_sha256=${fingerprint}`,
    );
  }

  /**
   * Single POST attempt. The signature header is sent on
   * every attempt (the body bytes are identical across
   * attempts; the receiver can verify the signature against
   * any of them).
   *
   * The result is a discriminated union:
   *   - `kind: 'success'`        — 2xx (or 3xx; we follow
   *     the redirect by default in `fetch`, but the
   *     receiver's terminal status is what we report)
   *   - `kind: 'client-error'`   — 4xx (no retry)
   *   - `kind: 'server-error'`   — 5xx (retry)
   *   - `kind: 'network-error'`  — fetch threw, or
   *     `AbortError` from the timeout (retry)
   */
  private async attemptOnce(
    url: string,
    body: string,
    signature: string,
    timestamp: number,
  ): Promise<
    | { kind: 'success'; status: number }
    | { kind: 'client-error'; status: number }
    | { kind: 'server-error'; status: number }
    | { kind: 'network-error'; error: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER_NAME]: signature,
          'x-nest-batch-timestamp': String(timestamp),
        },
        body,
        signal: controller.signal,
        // fetch follows 3xx redirects by default; the
        // redirect target's terminal status drives the
        // retry decision per the v1 contract
        // (`docs/RELEASE-0.2.0.md` §7.3).
        redirect: 'follow',
      });
      const status = response.status;
      if (status >= 200 && status < 300) {
        return { kind: 'success', status };
      }
      if (status >= 400 && status < 500) {
        return { kind: 'client-error', status };
      }
      // 5xx (and 3xx that somehow slipped past redirect:
      // should not happen with `redirect: 'follow'`, but
      // be defensive). Treat anything >= 500 as a
      // server-error and retry.
      return { kind: 'server-error', status };
    } catch (err) {
      // Network error, DNS failure, AbortError from the
      // timeout, etc. All treated as retryable per the v1
      // contract.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'network-error', error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds. Returns a promise that
 * resolves with no value. Used between retry attempts. The
 * `ms <= 0` short-circuit keeps the fast-mode test
 * schedule (`1ms`, `5ms`, ...) from producing timer
 * warnings.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Defensive deep-clone of an arbitrary `JsonValue`. The
 * `BatchEvent.data` field is typed as `JsonValue` and is
 * shared with the executor's internal state; we clone it
 * so the observer cannot mutate the executor by reference.
 * `structuredClone` is available in Node 17+ and is the
 * fastest safe deep-clone for JSON-shaped data.
 */
function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  // structuredClone can throw on non-cloneable values
  // (e.g. functions, symbols). The BatchEvent contract
  // guarantees `data` is `JsonValue`, so the catch is
  // purely defensive.
  try {
    return structuredClone(value) as T;
  } catch {
    return value;
  }
}

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

/**
 * The v1 webhook envelope payload. This is the contract the
 * receiver's parser expects. Fields are stable; new fields
 * are additive only and use the `x-` prefix to mark them
 * as out-of-contract for v1.
 */
export interface WebhookEnvelope {
  /** Envelope schema version. Always `1` for v1. */
  readonly version: 1;
  /** The `BatchEvent.type` string (e.g. `nest-batch.job.completed`). */
  readonly type: BatchEventType;
  /** Event timestamp as ISO-8601. */
  readonly timestamp: string;
  /** The `JobExecution.id` (a.k.a. `jobExecutionId`). */
  readonly jobId: string;
  /** The `StepExecution.id` (a.k.a. `stepExecutionId`). STEP\_\* / CHUNK\_\* / ITEM\_\* events only. */
  readonly stepId?: string;
  /** The `BatchEvent.data` payload, deep-cloned for safety. */
  readonly execution: unknown;
}

// Re-export the `BATCH_EVENT` constant so consumers can
// reference the exact subscription set without having to
// import `@nest-batch/core` themselves. The names of the
// event types are part of the public surface.
export { BATCH_EVENT };
