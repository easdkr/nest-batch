import type { BatchEventType } from '@nest-batch/core';

/**
 * Public options bag for `WebhookBatchModule.forRoot()`.
 *
 * The contract the test suite (`tests/webhook-observer.test.ts`,
 * T-AC-5) asserts against:
 *
 *   - `secret` is REQUIRED at the host level. It is never read from
 *     disk, never defaulted to an empty string, never logged in any
 *     code path. The optional `WEBHOOK_HMAC_SECRET` env var is the
 *     fallback ONLY when the host does not pass `secret` (env is
 *     the host-injection's safety net, not its primary).
 *   - `urls[]` is the fan-out set. Every subscribed event is POSTed
 *     to every URL in `urls`. Empty `urls` is a no-op (the observer
 *     still subscribes, it just never POSTs).
 *   - `events` is the subscription filter. Defaults to
 *     `[JOB_COMPLETED, JOB_FAILED, STEP_FAILED]`. Subscribed events
 *     are the only ones the observer signs + POSTs. A
 *     `JOB_STARTED` event arrives at `onEvent`, is not in the
 *     filter, and is dropped silently (the listener is fire-and-
 *     forget by contract — see `BatchObserver.onEvent`).
 *   - `attempts` is the number of total POST attempts (1 initial +
 *     up to `attempts-1` retries). Defaults to 4 (matching the
 *     fixed 1s/5s/25s/125s backoff schedule). Lowering the value
 *     is supported for tests; raising it is intentionally NOT
 *     supported in v1 (the retry schedule is the contract, see
 *     `docs/RELEASE-0.2.0.md` §7.2).
 *   - `timeoutMs` is the per-attempt HTTP timeout. Defaults to
 *     10 000 ms (10 seconds). A timeout is treated as a network
 *     error and retried through the full attempt budget.
 *   - `logger` is the Nest `Logger`-compatible interface used for
 *     the dead-letter `warn` line and the bootstrap notice. When
 *     omitted, the observer instantiates a `new Logger('WebhookBatchObserver')`.
 */
export interface WebhookBatchModuleOptions {
  /**
   * Host-injected HMAC-SHA256 secret used to sign outbound
   * envelopes. REQUIRED when not relying on the `WEBHOOK_HMAC_SECRET`
   * env fallback. Recommended length: 32+ bytes of randomness
   * (a per-environment secret, never re-used across services).
   *
   * The secret is bound to the `WebhookBatchObserver` instance at
   * `forRoot` time and is never exported, logged, serialized into
   * a dead-letter body, or otherwise observable by the host.
   */
  readonly secret?: string;

  /**
   * One or more absolute URLs the observer will fan out to on
   * every subscribed event. Empty array is a no-op (the observer
   * still subscribes to the event stream but never POSTs).
   */
  readonly urls: readonly string[];

  /**
   * Subscription filter. Defaults to
   * `[BATCH_EVENT.JOB_COMPLETED, BATCH_EVENT.JOB_FAILED,
   * BATCH_EVENT.STEP_FAILED]`. The v1 contract is these three
   * events only; a future v2 may widen the default to STEP_*
   * events.
   */
  readonly events?: readonly BatchEventType[];

  /**
   * Total number of POST attempts (initial + retries). Defaults
   * to 4. Must be `>= 1`; `1` means "no retries" (single POST,
   * then dead-letter on failure). Values `> 4` are clamped to 4
   * — the v1 retry schedule is `[1s, 5s, 25s, 125s]` and has
   * exactly 4 entries; further attempts would have no backoff to
   * look up.
   */
  readonly attempts?: number;

  /**
   * Per-attempt HTTP timeout in milliseconds. Defaults to
   * 10 000 (10 seconds). A timeout is treated as a network
   * error and retried through the full attempt budget.
   */
  readonly timeoutMs?: number;

  /**
   * Logger override. The observer is built to use a NestJS
   * `Logger`-compatible interface (the four `log` / `warn` /
   * `error` / `debug` methods). When omitted, the observer
   * instantiates a `new Logger('WebhookBatchObserver')` against
   * the `console`-backed Nest logger.
   */
  readonly logger?: WebhookLogger;
}

/**
 * NestJS-`Logger`-compatible surface used by `WebhookBatchObserver`.
 *
 * We type this as a structural subset of `@nestjs/common`'s
 * `LoggerService` so the host can pass a custom logger without
 * having to import the full Nest surface. The four methods are
 * the only ones the observer calls:
 *
 *   - `log`   — bootstrap / info-level messages
 *   - `warn`  — dead-letter payload (post final failure)
 *   - `error` — configuration / startup errors
 *   - `debug` — per-attempt diagnostic info (URL, status, latency)
 */
export interface WebhookLogger {
  log(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  error(message: string, context?: string): void;
  debug(message: string, context?: string): void;
}

/**
 * Fully-resolved options bag the observer consumes at runtime.
 * `forRoot` is responsible for filling in every default and
 * freezing the result before handing it to the provider.
 */
export interface ResolvedWebhookOptions {
  readonly secret: string;
  readonly urls: readonly string[];
  readonly events: readonly BatchEventType[];
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly logger: WebhookLogger;
}

/**
 * The v1 default subscription set. Documented in
 * `docs/RELEASE-0.2.0.md` §7.1 and in the README.
 */
export const DEFAULT_WEBHOOK_EVENTS: readonly BatchEventType[] = [
  // JOB_COMPLETED, JOB_FAILED, STEP_FAILED
  // We do not import BATCH_EVENT here to avoid a circular
  // dep (the observer re-uses this list at construction
  // time). The constant is the v1 contract; a future v2
  // may widen the default to STEP_*, CHUNK_*, ITEM_*.
  'nest-batch.job.completed',
  'nest-batch.job.failed',
  'nest-batch.step.failed',
] as const;

/**
 * The v1 fixed backoff schedule. Four entries (3 delays between
 * 4 attempts). Documented in `docs/RELEASE-0.2.0.md` §7.2 and
 * in the README. The schedule is the contract the test suite
 * asserts against.
 */
export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 5_000, 25_000, 125_000,
] as const;

/**
 * Fast-mode override for the retry schedule. Activated when
 * `process.env.WEBHOOK_TEST_FAST === '1'`. The override exists
 * so the test suite can exercise the 4-attempt retry path
 * without waiting 156 seconds (1+5+25+125). Test-only; never
 * touched in production. Documented in the README.
 */
export const FAST_WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  1, 5, 25, 125,
] as const;

/**
 * The DI token under which the resolved options are stored.
 * `Symbol.for` keeps the key process-scoped and stable across
 * module versions, mirroring the pattern in
 * `packages/bullmq/src/module-options.ts`.
 */
export const WEBHOOK_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/webhook/MODULE_OPTIONS',
);

/**
 * Resolve a partial `WebhookBatchModuleOptions` into a fully-
 * populated `ResolvedWebhookOptions`. Called by `forRoot` so the
 * provider always sees a frozen, default-filled bag.
 *
 * Resolution rules:
 *   - `secret`: if absent, fall back to `process.env.WEBHOOK_HMAC_SECRET`.
 *     If still absent, throw — the host MUST provide a secret one
 *     way or another.
 *   - `urls`: required, no default. Empty array is allowed (no-op
 *     fan-out).
 *   - `events`: defaults to `DEFAULT_WEBHOOK_EVENTS`. A `[]` value
 *     is honoured (the observer subscribes to nothing).
 *   - `attempts`: defaults to 4. Clamped to `[1, 4]`.
 *   - `timeoutMs`: defaults to 10 000. Clamped to `>= 100` so the
 *     observer cannot be configured into "immediate timeout" mode.
 *   - `logger`: defaults to a `new Logger('WebhookBatchObserver')`.
 */
export function resolveWebhookOptions(
  raw: WebhookBatchModuleOptions,
): ResolvedWebhookOptions {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      '[WebhookBatchModule] options must be a non-null object',
    );
  }
  const secret = pickSecret(raw.secret);
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      '[WebhookBatchModule] secret is required: pass `secret` to ' +
        'forRoot() or set the WEBHOOK_HMAC_SECRET env var',
    );
  }
  const urls = Array.isArray(raw.urls) ? raw.urls.slice() : [];
  for (const url of urls) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        '[WebhookBatchModule] every entry in `urls` must be a non-empty string',
      );
    }
  }
  const events = Array.isArray(raw.events) && raw.events.length > 0
    ? raw.events.slice()
    : DEFAULT_WEBHOOK_EVENTS.slice();
  const rawAttempts = typeof raw.attempts === 'number' ? raw.attempts : 4;
  const attempts = Math.max(1, Math.min(4, Math.floor(rawAttempts)));
  const rawTimeout = typeof raw.timeoutMs === 'number' ? raw.timeoutMs : 10_000;
  const timeoutMs = Math.max(100, Math.floor(rawTimeout));
  return Object.freeze({
    secret,
    urls,
    events,
    attempts,
    timeoutMs,
    logger: raw.logger ?? defaultLogger(),
  });
}

/**
 * Pick the secret: host-injected first, env-var fallback second.
 * Returns `undefined` if neither is set so the caller can throw
 * a precise error.
 */
function pickSecret(hostInjected: string | undefined): string | undefined {
  if (typeof hostInjected === 'string' && hostInjected.length > 0) {
    return hostInjected;
  }
  const fromEnv = process.env['WEBHOOK_HMAC_SECRET'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  return undefined;
}

/**
 * The default `WebhookLogger` — a thin adapter around
 * `console`. The observer is built to be test-friendly; tests
 * pass a captured-`console.warn` spy via the `logger` option.
 */
function defaultLogger(): WebhookLogger {
  // We deliberately do NOT import @nestjs/common's `Logger` here
  // — the `WebhookLogger` is a structural interface, and the
  // adapter lets the package stay test-runner-agnostic. Tests
  // pass a console-backed spy; hosts pass a NestJS `Logger`
  // instance (the structural shape matches the official
  // `LoggerService`).
  return {
    log: (message: string) => {
      // eslint-disable-next-line no-console
      console.log(`[WebhookBatchObserver] ${message}`);
    },
    warn: (message: string) => {
      // eslint-disable-next-line no-console
      console.warn(`[WebhookBatchObserver] ${message}`);
    },
    error: (message: string) => {
      // eslint-disable-next-line no-console
      console.error(`[WebhookBatchObserver] ${message}`);
    },
    debug: (message: string) => {
      // eslint-disable-next-line no-console
      console.debug(`[WebhookBatchObserver] ${message}`);
    },
  };
}
