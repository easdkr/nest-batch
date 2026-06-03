/**
 * BullMQ Redis connection options accepted by `BullmqBatchModule`.
 *
 * `BullMQ` is opinionated about Redis client behavior: workers and
 * producers must opt into different connection options so that a
 * Redis outage is observed correctly in each role:
 *
 *   - Workers MUST set `maxRetriesPerRequest: null` and
 *     `enableReadyCheck: false`. BullMQ's internal blocking commands
 *     (`BLPOP`, `BRPOPLPUSH`, `XREADGROUP`) MUST NOT retry
 *     per-request — a stalled worker will not surface as a connection
 *     error. The Redis client is expected to keep retrying
 *     `reconnectOnError` until the operator intervenes.
 *
 *   - Producers (the `Queue` used to enqueue work) MUST set
 *     `enableOfflineQueue: false` so that a Redis-down condition
 *     raises an error *synchronously* on the enqueue call rather than
 *     buffering the command and returning success. The `JobLauncher`
 *     propagates the failure to the caller, so the call site can
 *     mark the `JobExecution` as `FAILED` and surface the error
 *     to its caller (HTTP, RPC, cron trigger, ...).
 *
 * Both roles share `host` / `port` / `password` / `username` /
 * `db` / `keyPrefix` / `tls` for connection-target configuration. The
 * role-specific tuning lives on `BullMqConnectionOptions` so callers
 * declare the split explicitly. The default keyPrefix is
 * `nest-batch:` — every key the package writes is namespaced under
 * it, and a key-collision in a shared Redis is impossible.
 *
 * The interface is intentionally `Partial<>`-friendly: a host that
 * only needs a local single-node Redis can pass `{ host: '127.0.0.1' }`
 * and accept all defaults.
 */
export interface BullMqConnectionOptions {
  /** Redis host (default: `'127.0.0.1'`). */
  host?: string;
  /** Redis port (default: `6379`). */
  port?: number;
  /** AUTH password, if any. */
  password?: string;
  /** ACL username, if any (Redis 6+ ACL). */
  username?: string;
  /** Logical database index (default: `0`). */
  db?: number;
  /**
   * Key prefix. Every BullMQ key the package writes is prefixed with
   * this string (BullMQ appends its own `bull:` after the prefix).
   * Default: `'nest-batch:'`.
   */
  keyPrefix?: string;
  /** Enable TLS for the connection. */
  tls?: boolean;
}

/**
 * Resolved Redis connection settings, with all defaults filled in.
 *
 * `BullmqBatchModule.forRoot()` returns a frozen copy of this object
 * under its module-options token; `BullMqExecutionStrategy` reads it
 * to build the `ConnectionOptions` passed into BullMQ's `Queue` /
 * `Worker` / `QueueEvents` constructors.
 */
export interface BullMqResolvedConnection {
  readonly host: string;
  readonly port: number;
  readonly password: string | undefined;
  readonly username: string | undefined;
  readonly db: number;
  readonly keyPrefix: string;
  readonly tls: boolean;
}

export const BULLMQ_DEFAULT_HOST = '127.0.0.1';
export const BULLMQ_DEFAULT_PORT = 6379;
export const BULLMQ_DEFAULT_KEY_PREFIX = 'nest-batch:';

/**
 * Fill in defaults for a `BullMqConnectionOptions` bag and return a
 * frozen, fully-resolved connection descriptor.
 *
 * Splitting this out from the module factory keeps the module file
 * focused on DI plumbing and lets the strategy (and tests) construct
 * a resolved connection without re-implementing the defaults.
 */
export function resolveBullMqConnection(
  options: BullMqConnectionOptions | undefined,
): BullMqResolvedConnection {
  return Object.freeze({
    host: options?.host ?? BULLMQ_DEFAULT_HOST,
    port: options?.port ?? BULLMQ_DEFAULT_PORT,
    password: options?.password,
    username: options?.username,
    db: options?.db ?? 0,
    keyPrefix: options?.keyPrefix ?? BULLMQ_DEFAULT_KEY_PREFIX,
    tls: options?.tls ?? false,
  });
}
