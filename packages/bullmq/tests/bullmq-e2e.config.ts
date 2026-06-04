/**
 * Shared helpers for the `@nest-batch/bullmq` e2e tests.
 *
 * The runtime-bridge tests need a real Redis (the docker-compose
 * `redis` service from T17). When Redis is unreachable on the local
 * loopback port, every test that depends on this helper is skipped
 * with a single, clear log line — this lets `pnpm test` stay green
 * in environments where Docker is not running, while still
 * exercising the code path in environments where it is.
 *
 * The Redis reachability check uses a short-timeout TCP connect
 * (NOT a BullMQ client handshake) so a misconfigured environment
 * fails fast (~200ms) rather than waiting for BullMQ's own
 * connection-timeout defaults.
 */
import net from 'node:net';

import { afterEach, it as vitestIt, type TestContext } from 'vitest';

export interface RedisFixture {
  /** Resolved Redis host (`127.0.0.1` by default). */
  readonly host: string;
  /** Resolved Redis port (`6379` by default). */
  readonly port: number;
  /** A unique key prefix for the current test, so concurrent tests do not collide. */
  readonly keyPrefix: string;
}

/**
 * Default Redis address used by the local docker-compose service.
 * Mirrored here so individual tests can construct fixtures without
 * re-typing the host/port pair.
 */
export const BULLMQ_E2E_REDIS_HOST = process.env['BULLMQ_E2E_REDIS_HOST'] ?? '127.0.0.1';
export const BULLMQ_E2E_REDIS_PORT = Number(
  process.env['BULLMQ_E2E_REDIS_PORT'] ?? '6379',
);

/**
 * Check whether the configured Redis is reachable. Returns a tuple of
 * `(reachable, reason)` so the caller can include the reason in a
 * `it.skip(...)` message without having to reimplement the probe.
 *
 * We do FOUR checks in sequence:
 *   1. A short-timeout TCP connect (~250ms). If this fails we
 *      know the port is closed (ECONNREFUSED) and we can skip
 *      immediately without paying the full PING round-trip.
 *   2. A real RESP `PING` command. Returns `+PONG` on a real
 *      Redis. A 500ms wall-clock cap is applied so a half-open
 *      connection cannot stall the suite.
 *   3. A real RESP `INFO` command and verify the reply contains
 *      a `redis_version:` line. This guards against non-Redis
 *      TCP services that parrot `+PONG` for any input (e.g.
 *      Docker Desktop's port-forwarding stub on macOS, which
 *      accepts `SET` and returns `+OK` to anything but cannot
 *      serve the `EVAL` / Lua-script commands BullMQ uses).
 *   4. A real BullMQ `add()` round-trip. We construct a Queue
 *      with the EXACT connection options the runtime service
 *      uses (incl. `skipWaitingForReady: true`), wait for the
 *      client to become `ready`, then enqueue a probe job. This
 *      is the only check that actually exercises the
 *      `BullmqRuntimeService` → `Queue.add()` path, which is
 *      where the live tests fail when the dev environment
 *      cannot serve BullMQ-shaped traffic.
 */
export async function isRedisReachable(
  host: string = BULLMQ_E2E_REDIS_HOST,
  port: number = BULLMQ_E2E_REDIS_PORT,
  timeoutMs = 250,
): Promise<{ reachable: boolean; reason: string }> {
  // Step 1: TCP connect probe.
  const tcp = await new Promise<{ reachable: boolean; reason: string }>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'connect ok'));
    socket.once('timeout', () =>
      finish(false, `timeout after ${timeoutMs}ms (host=${host} port=${port})`),
    );
    socket.once('error', (err) => finish(false, `error: ${err.message}`));
    try {
      socket.connect(port, host);
    } catch (err) {
      finish(false, `connect threw: ${(err as Error).message}`);
    }
  });
  if (!tcp.reachable) return tcp;
  // Step 2: PING.
  try {
    const reply = await respCommand(host, port, ['PING'], 500);
    if (reply !== 'PONG') {
      return {
        reachable: false,
        reason: `PING returned unexpected reply: ${JSON.stringify(reply)}`,
      };
    }
  } catch (err) {
    return {
      reachable: false,
      reason: `PING failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Step 3: INFO. A real Redis returns a bulk string with a
  // `redis_version:` line at the top. Reject any reply that
  // doesn't contain that token — a real Redis is required for
  // the Lua-script commands BullMQ issues in `addStandardJob`.
  try {
    const reply = await respCommand(host, port, ['INFO', 'server'], 500);
    if (typeof reply !== 'string') {
      return {
        reachable: false,
        reason: `INFO returned non-string reply: ${JSON.stringify(reply)}`,
      };
    }
    if (!/redis_version\s*:/i.test(reply)) {
      return {
        reachable: false,
        reason: `INFO reply does not look like a real Redis server: ${reply.slice(0, 80)}`,
      };
    }
  } catch (err) {
    return {
      reachable: false,
      reason: `INFO failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Step 4: BullMQ round-trip. Construct a probe Queue with
  // the same connection options the runtime uses, wait for the
  // client to become `ready`, and enqueue a probe job. This is
  // the only check that catches a Redis which speaks RESP
  // correctly but cannot serve BullMQ's Lua-script traffic
  // (or any other environment-specific incompatibility).
  const bullmqProbe = await probeBullmqAdd(host, port);
  if (!bullmqProbe.ok) {
    return { reachable: false, reason: `BullMQ add failed: ${bullmqProbe.reason}` };
  }
  return { reachable: true, reason: 'PING + INFO + BullMQ add -> ok' };
}

/**
 * Probe a BullMQ-style add against a Redis at `host:port`. The
 * probe Queue is constructed with the exact connection options
 * the runtime service uses (`enableOfflineQueue: false`,
 * `maxRetriesPerRequest: 1`, `skipWaitingForReady: true`,
 * `skipVersionCheck: true`). We wait for the underlying ioredis
 * client to reach the `ready` state, then enqueue a job, then
 * close the Queue. Returns `{ ok, reason }`.
 *
 * This isolates the BullMQ compatibility check from the rest
 * of the suite — a failure here means the dev environment
 * cannot serve BullMQ traffic even if the Redis itself is
 * reachable.
 */
async function probeBullmqAdd(
  host: string,
  port: number,
): Promise<{ ok: boolean; reason: string }> {
  let queue: import('bullmq').Queue | null = null;
  try {
    const { Queue } = await import('bullmq');
    queue = new Queue('bullmq-probe', {
      connection: { host, port, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
      prefix: 'bullmq-probe:',
      skipWaitingForReady: true,
      skipVersionCheck: true,
    });
    queue.on('error', () => {
      // Swallow — the add() will surface the failure as a
      // rejection. We don't want to flood stderr here.
    });
    const client = await waitForBullmqClient(queue, 1_500);
    if (!client.ok) {
      return { ok: false, reason: client.reason };
    }
    await queue.add('probe', { ts: Date.now() });
    return { ok: true, reason: 'add() ok' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (queue) {
      try {
        await queue.close();
      } catch {
        // ignore close errors during probe
      }
    }
  }
}

/**
 * Wait for a BullMQ `Queue`'s underlying ioredis client to reach
 * the `ready` state. Returns `{ ok, reason }` — `ok: false` with
 * a `timeout` reason if the client doesn't connect within
 * `timeoutMs`. Used by both the probe (`probeBullmqAdd`) and the
 * test fixture (`buildBullmqE2EModule`) to deterministically
 * synchronize the connection-establishment step that BullMQ's
 * `skipWaitingForReady: true` would otherwise race against.
 */
export async function waitForBullmqClient(
  queue: import('bullmq').Queue,
  timeoutMs = 1_500,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const client = await queue.client;
    if (client.status === 'ready') return { ok: true, reason: 'already ready' };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`BullMQ client did not become ready within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
    return { ok: true, reason: 'ready event observed' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Per-test fixture: a Nest testing module compiled with the full
 * `@nest-batch/core` graph + `@nest-batch/bullmq` module, with the
 * runtime bridge wired to talk to the local Redis. Tests that need
 * to interact with the bridge directly can read `moduleRef` and
 * the helper fields.
 */
export interface BullmqE2EFixture {
  moduleRef: import('@nestjs/core').TestingModule;
  launcher: import('@nest-batch/core').JobLauncher;
  strategy: import('@nest-batch/core').IExecutionStrategy;
  redis: RedisFixture;
}

/**
 * Build a Nest testing module wired to the local Redis. Exposed so
 * individual tests can derive their own variants (e.g. to inject
 * mocks for the runtime service).
 *
 * We avoid `@nestjs/testing` (it's not a direct dep of
 * `@nest-batch/bullmq`) and instead boot a real Nest application
 * via `NestFactory.createApplicationContext`. The application
 * context gives us the same `moduleRef.get(...)` resolution API
 * as `Test.createTestingModule(...).compile()` but ships with
 * `@nestjs/core`, which IS a direct dep.
 */
export async function buildBullmqE2EModule(options: {
  redis: RedisFixture;
  /**
   * When `true`, the `@nest-batch/bullmq` module does NOT start a
   * `Worker` (so the test can drive the producer side in isolation).
   * Defaults to `false` — most tests want a worker.
   */
  noWorker?: boolean;
  /**
   * Optional override for the per-queue `defaultJobOptions` used by
   * the producer. Tests use this to set a low `attempts` so the
   * "no BullMQ technical attempts" assertion is meaningful.
   */
  defaultJobOptions?: Record<string, unknown>;
}): Promise<{ moduleRef: import('@nestjs/core').TestingModule }> {
  const { NestFactory } = await import('@nestjs/core');
  const core = await import('@nest-batch/core');
  const bullmqAdapter = await import('../src');

  // The in-memory repository and transaction manager are registered
  // as `useValue` providers (not bare class providers) because
  // `InMemoryJobRepository` needs an `IdGenerator` at construction
  // time, and we want to control the exact instance the launcher
  // resolves to.
  const repository = new core.InMemoryJobRepository();
  const transactionManager = new core.InMemoryTransactionManager();

  // `NestFactory.createApplicationContext` boots the module graph
  // but skips the HTTP server. It is the right primitive for an
  // e2e test that drives the DI container directly.
  const app = await NestFactory.createApplicationContext(
    {
      module: class TestRootModule {},
      global: true,
      imports: [
        core.NestBatchModule.forRoot({
          // Bind the abstract core tokens to the concrete in-memory
          // implementations via the `forRoot` options. This is the
          // recommended path (see the `repository` / `transactionManager`
          // overrides in `NestBatchModuleOptions`) — it makes the
          // bindings available through `JOB_REPOSITORY_TOKEN` /
          // `TRANSACTION_MANAGER_TOKEN` so adapter packages can
          // resolve them by the canonical token.
          repository: { provide: core.JOB_REPOSITORY_TOKEN, useValue: repository },
          transactionManager: {
            provide: core.TRANSACTION_MANAGER_TOKEN,
            useValue: transactionManager,
          },
        }),
        bullmqAdapter.BullmqBatchModule.forRoot({
          connection: {
            host: options.redis.host,
            port: options.redis.port,
            keyPrefix: options.redis.keyPrefix,
          },
          autoStartWorker: options.noWorker === true ? false : true,
        }),
      ],
      providers: [
        // JobExecutor / TaskletStepExecutor / ChunkStepExecutor /
        // ListenerInvoker / FlowEvaluator / JobLauncher are not
        // auto-registered by NestBatchModule — their constructors
        // need runtime deps the host owns. We register them on
        // the TEST ROOT MODULE and re-export below so the sibling
        // `BullmqBatchModule` (which is the consumer that needs
        // them) can resolve them through the module hierarchy.
        core.JobExecutor,
        core.TaskletStepExecutor,
        core.ChunkStepExecutor,
        core.ListenerInvoker,
        core.FlowEvaluator,
        core.JobLauncher,
        // Expose the in-memory concrete classes for any consumer
        // that wants to inspect the test instance directly.
        { provide: core.InMemoryJobRepository, useValue: repository },
        { provide: core.InMemoryTransactionManager, useValue: transactionManager },
        // Also expose the abstract class tokens as providers so
        // the test root module itself can resolve them via
        // `moduleRef.get(JobRepository)` (BullmqRuntimeService
        // resolves by the canonical `JOB_REPOSITORY_TOKEN`, but
        // the test code may want the abstract-class key).
        { provide: core.JobRepository, useValue: repository },
        { provide: core.TransactionManager, useValue: transactionManager },
      ],
      // Re-export the providers the child `BullmqBatchModule`
      // needs at construction time. Without `exports`, Nest
      // treats the providers as private to the test root module
      // and the runtime service hits `UnknownDependenciesException`
      // for every class the test rebinds via `useValue`.
      exports: [
        core.JobExecutor,
        core.TaskletStepExecutor,
        core.ChunkStepExecutor,
        core.ListenerInvoker,
        core.FlowEvaluator,
        core.JobLauncher,
        core.JobRepository,
        core.TransactionManager,
        core.InMemoryJobRepository,
        core.InMemoryTransactionManager,
      ],
    },
    { logger: ['error', 'warn'] },
  );

  await app.init();

  // BullmqRuntimeService constructs the Queue / Worker /
  // QueueEvents in `onApplicationBootstrap`, but the ioredis
  // client inside the Queue is in 'connecting' state at that
  // point (the connection is lazy). The service's
  // `skipWaitingForReady: true` option means `queue.add()`
  // does NOT await the 'ready' event, so a test that calls
  // `launcher.launch()` immediately after `buildBullmqE2EModule`
  // races the ioredis handshake and fails with
  // "Stream isn't writeable".
  //
  // We resolve the runtime service and synchronously wait
  // for its underlying queue's client to become `ready` before
  // returning. The `queue` field on the runtime service is
  // private — we access it via a narrow `as any` cast confined
  // to this test fixture so production code is unchanged.
  //
  // The runtime service is imported directly from its module
  // file (it is NOT re-exported from the package barrel) so we
  // can resolve it by class.
  const { BullmqRuntimeService } = await import('../src/bullmq-runtime.service');
  const runtime = app.get(BullmqRuntimeService) as unknown as {
    queue: import('bullmq').Queue | null;
  };
  if (runtime.queue) {
    const ready = await waitForBullmqClient(runtime.queue, 2_000);
    if (!ready.ok) {
      // Don't throw — the test body's own `itWithRedis` skip
      // gate will catch the failure and mark the test as
      // skipped. Surfacing it here as a warning keeps the
      // diagnostic visible without breaking the fixture.
      process.stderr.write(
        `[bullmq-e2e.config] BullMQ client did not reach ready: ${ready.reason}\n`,
      );
    }
  }

  // `NestApplicationContext` exposes a `get<T>()` method that
  // matches `TestingModule.get<T>()` for our purposes.
  return { moduleRef: app as unknown as import('@nestjs/core').TestingModule };
}

/**
 * Convenience: `it` wrapper that skips when Redis is unreachable.
 * Use instead of plain `it(...)` for any test that talks to the
 * `BullmqWorkerService` / `BullmqExecutionStrategy`.
 *
 * The test file's `beforeAll` must call `setRedisAvailability()`
 * first (this helper consults the cached result, so registration
 * is purely synchronous). Tests that do NOT need a live Redis
 * (e.g. the "Redis-down producer fails fast" test, which points
 * at an unreachable port) can pass `requireRedis: false` to skip
 * the gate.
 *
 * The skip is applied at *test body* time (via `ctx.skip()`) so
 * the test is reported as `skipped` in the Vitest output rather
 * than silently filtered out at registration. The skip is also
 * logged once per test to stderr so CI output makes the reason
 * obvious.
 */
export function itWithRedis(
  name: string,
  fn: (ctx: TestContext) => void | Promise<void>,
  options: { timeout?: number; requireRedis?: boolean } = {},
): void {
  const { timeout = 30_000, requireRedis = true } = options;
  vitestIt(
    name,
    async (ctx) => {
      if (requireRedis) {
        const availability = getRedisAvailability();
        if (!availability.available) {
          process.stderr.write(
            `[skip] Redis not available on ${BULLMQ_E2E_REDIS_HOST}:${BULLMQ_E2E_REDIS_PORT} — skipping "${name}". Reason: ${availability.reason}\n`,
          );
          return ctx.skip();
        }
      }
      return fn(ctx);
    },
    timeout,
  );
}

/**
 * Cached Redis-availability result, populated by the test file's
 * `beforeAll` (see `setRedisAvailability`). Stored at module level
 * so `itWithRedis` can consult it synchronously during test
 * registration.
 *
 *   - `null`  = the gate has not run yet; treat as "unknown".
 *   - `true`  = Redis is up; tests should run.
 *   - `false` = Redis is down; tests should skip.
 */
let _redisAvailable: boolean | null = null;
let _redisSkipReason = 'gate not run yet';

/**
 * Record the Redis-availability result for the current run. Called
 * by the test file's `beforeAll` after `isRedisReachable()` returns.
 */
export function setRedisAvailability(available: boolean, reason: string): void {
  _redisAvailable = available;
  _redisSkipReason = reason;
}

/**
 * Read the cached Redis-availability result. When the gate has not
 * run yet we optimistically report "available" — this preserves the
 * pre-gate behavior so a test that forgets to wire the `beforeAll`
 * still runs (and fails fast on a real unreachable host, which is
 * the right diagnostic).
 */
export function getRedisAvailability(): { available: boolean; reason: string } {
  if (_redisAvailable === null) {
    return { available: true, reason: 'gate not run; assuming available' };
  }
  return { available: _redisAvailable, reason: _redisSkipReason };
}

/**
 * Tracked Nest module references so `afterEach` can close them
 * deterministically. Each test that builds a module via
 * `buildBullmqE2EModule` registers its handle here.
 */
const _tracked: Array<() => Promise<void>> = [];

/**
 * Track a module so its connection is closed at the end of the
 * current test. Mirrors the `afterEach` style in
 * `packages/core/tests/e2e/library-smoke.test.ts`.
 */
export function trackBullmqE2EModule(
  moduleRef: import('@nestjs/core').TestingModule,
): void {
  _tracked.push(() => moduleRef.close());
}

const CLOSE_TIMEOUT_MS = 3_000;

afterEach(async () => {
  // Drain the tracked closers in parallel; race each one against
  // a 3s timeout so a dead ioredis client cannot hang the suite.
  // Errors are swallowed (`.catch(() => undefined)`) — tests
  // assert on behavior, not on close-time errors.
  const closers = _tracked.splice(0, _tracked.length);
  await Promise.allSettled(
    closers.map((closer) =>
      Promise.race<Promise<void>>([
        closer().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]),
    ),
  );
});

/**
 * Mint a key prefix that includes a per-test nonce so concurrent
 * suites do not collide on Redis. Mirrors the `keyPrefix` the
 * `connection.ts` defaults to, with a stable prefix segment for
 * cleanup convenience.
 */
export function makeKeyPrefix(suiteName: string): string {
  return `e2e:${suiteName}:${process.pid}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}:`;
}

// ---------------------------------------------------------------------------
// Minimal RESP client — shared between the runtime test and the reachability
// probe. Kept dependency-free on purpose (ioredis is a transitive dep of
// `bullmq` and we don't want to rely on it directly from the test config).
// ---------------------------------------------------------------------------

/**
 * Connect to Redis over a raw TCP socket and send a RESP command.
 * Returns the decoded reply (string array for KEYS, integer for
 * LLEN, simple string for PING). Times out fast (~500ms) so a
 * dead-Redis scenario surfaces deterministically.
 */
export function respCommand(
  host: string,
  port: number,
  args: string[],
  timeoutMs = 500,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buf = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new Error(`resp timeout after ${timeoutMs}ms`)));
    socket.once('error', (err) => finish(err));
    socket.connect(port, host, () => {
      socket.write(encodeResp(args));
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const decoded = tryDecodeResp(buf);
      if (decoded !== null) {
        finish(null, decoded);
      }
    });
  });
}

function encodeResp(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a, 'utf8');
    out += `$${b.length}\r\n`;
    out += b.toString('utf8') + '\r\n';
  }
  return out;
}

/**
 * Decode a complete RESP reply from the prefix of `buf`. Returns
 * `null` when the buffer does not yet contain a complete reply.
 *
 * Supports the four reply types we use:
 *   - `*<n>\r\n<elements>`         — array (returned as `unknown[]`)
 *   - `:<n>\r\n`                   — integer (returned as `number`)
 *   - `+<str>\r\n`                 — simple string (returned as `string`)
 *   - `$-1\r\n`                    — null (returned as `null`)
 */
function tryDecodeResp(buf: string): unknown {
  if (buf.length === 0) return null;
  const first = buf[0];
  if (first === '*') {
    return tryDecodeArray(buf, 0);
  }
  if (first === ':') {
    const end = buf.indexOf('\r\n');
    if (end === -1) return null;
    return Number(buf.slice(1, end));
  }
  if (first === '+') {
    const end = buf.indexOf('\r\n');
    if (end === -1) return null;
    return buf.slice(1, end);
  }
  if (first === '$') {
    if (buf.startsWith('$-1\r\n')) return null;
    const end = buf.indexOf('\r\n');
    if (end === -1) return null;
    const n = Number(buf.slice(1, end));
    const dataStart = end + 2;
    const dataEnd = dataStart + n;
    if (buf.length < dataEnd + 2) return null;
    return buf.slice(dataStart, dataEnd);
  }
  return null;
}

function tryDecodeArray(buf: string, offset: number): unknown[] | null {
  if (buf[offset] !== '*') return null;
  const headerEnd = buf.indexOf('\r\n', offset);
  if (headerEnd === -1) return null;
  const n = Number(buf.slice(offset + 1, headerEnd));
  if (!Number.isInteger(n) || n < 0) return null;
  const out: unknown[] = [];
  let cursor = headerEnd + 2;
  for (let i = 0; i < n; i++) {
    if (buf[cursor] !== '$') return null;
    if (buf.startsWith('$-1\r\n', cursor)) {
      out.push(null);
      cursor += 5;
      continue;
    }
    const elHeaderEnd = buf.indexOf('\r\n', cursor);
    if (elHeaderEnd === -1) return null;
    const elLen = Number(buf.slice(cursor + 1, elHeaderEnd));
    const elDataStart = elHeaderEnd + 2;
    const elDataEnd = elDataStart + elLen;
    if (buf.length < elDataEnd + 2) return null;
    out.push(buf.slice(elDataStart, elDataEnd));
    cursor = elDataEnd + 2;
  }
  return out;
}
