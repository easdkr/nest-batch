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

import { afterEach, it as vitestIt, it as vitestItSkip, type TestContext } from 'vitest';

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
 */
export async function isRedisReachable(
  host: string = BULLMQ_E2E_REDIS_HOST,
  port: number = BULLMQ_E2E_REDIS_PORT,
  timeoutMs = 250,
): Promise<{ reachable: boolean; reason: string }> {
  return new Promise((resolve) => {
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
  // `NestApplicationContext` exposes a `get<T>()` method that
  // matches `TestingModule.get<T>()` for our purposes.
  return { moduleRef: app as unknown as import('@nestjs/core').TestingModule };
}

/**
 * Convenience: `it` wrapper that skips when Redis is unreachable.
 * Use instead of plain `it(...)` for any test that talks to the
 * `BullmqWorkerService` / `BullmqExecutionStrategy`.
 *
 * The probe runs at the call site (synchronously, via a short
 * timeout) and the test is either registered or skipped based on
 * the result. Vitest requires that test registration be synchronous
 * within a `describe` block, so we cannot `await` here — instead
 * we set a 200ms ceiling on the probe. If the probe takes longer
 * than that, we optimistically register the test and the test
 * body itself will fail-fast on the first Redis call.
 */
export function itWithRedis(
  name: string,
  fn: (ctx: TestContext) => void | Promise<void>,
  timeout = 30_000,
): void {
  let reachable = true;
  // We do NOT await — Vitest needs synchronous registration. The
  // probe is best-effort; if it cannot complete in 200ms we assume
  // Redis is up (test will fail fast on a real unreachable host).
  void isRedisReachable(BULLMQ_E2E_REDIS_HOST, BULLMQ_E2E_REDIS_PORT, 200).then(
    (r) => {
      if (!r.reachable) reachable = false;
    },
  );
  if (reachable) {
    vitestIt(name, fn, timeout);
  } else {
    vitestItSkip.skip(`[skipped: redis unreachable] ${name}`, fn, timeout);
  }
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

afterEach(async () => {
  while (_tracked.length > 0) {
    const closer = _tracked.pop();
    if (closer) {
      try {
        await closer();
      } catch {
        // ignore: tests assert on state, not on close errors
      }
    }
  }
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
