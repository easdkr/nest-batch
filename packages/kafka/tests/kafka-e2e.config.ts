/**
 * Shared helpers for the `@nest-batch/kafka` e2e tests.
 *
 * The runtime-bridge tests need a real Kafka broker (the docker-compose
 * `kafka` service). When Kafka is unreachable on the local
 * loopback port, every test that depends on this helper is skipped
 * with a single, clear log line — this lets `pnpm test` stay green
 * in environments where Docker is not running, while still
 * exercising the code path in environments where it is.
 */
import net from 'node:net';

import { afterEach, it as vitestIt, type TestContext } from 'vitest';

export interface KafkaFixture {
  /** Resolved Kafka broker host (`127.0.0.1` by default). */
  readonly host: string;
  /** Resolved Kafka broker port (`9092` by default). */
  readonly port: number;
  /** A unique client id prefix for the current test, so concurrent tests do not collide. */
  readonly clientId: string;
  /** A unique topic name for the current test. */
  readonly topic: string;
  /** A unique consumer group id for the current test, so concurrent tests do not share partitions. */
  readonly consumerGroupId: string;
}

/**
 * Default Kafka address used by the local docker-compose service.
 */
export const KAFKA_E2E_HOST = process.env['KAFKA_E2E_HOST'] ?? '127.0.0.1';
export const KAFKA_E2E_PORT = Number(
  process.env['KAFKA_E2E_PORT'] ?? '9092',
);

/**
 * Check whether the configured Kafka broker is reachable. Returns
 * `(reachable, reason)` so the caller can include the reason in a
 * skip message.
 *
 * We do TWO checks in sequence:
 *   1. A short-timeout TCP connect (~250ms). If this fails we
 *      know the port is closed (ECONNREFUSED) and we can skip
 *      immediately.
 *   2. A real KafkaJS producer round-trip. We construct a
 *      producer with the EXACT connection options the runtime
 *      service uses, connect, send a probe message, then
 *      disconnect. This is the only check that actually
 *      exercises the `KafkaRuntimeService` → producer path.
 */
export async function isKafkaReachable(
  host: string = KAFKA_E2E_HOST,
  port: number = KAFKA_E2E_PORT,
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

  // Step 2: KafkaJS producer round-trip.
  const kafkaProbe = await probeKafkaSend(host, port);
  if (!kafkaProbe.ok) {
    return { reachable: false, reason: `Kafka send failed: ${kafkaProbe.reason}` };
  }
  return { reachable: true, reason: 'TCP + Kafka send -> ok' };
}

/**
 * Probe a Kafka-style send against a broker at `host:port`. The
 * probe producer is constructed with the exact connection options
 * the runtime service uses. We connect, send a probe message to a
 * probe topic, then disconnect. Returns `{ ok, reason }`.
 */
async function probeKafkaSend(
  host: string,
  port: number,
): Promise<{ ok: boolean; reason: string }> {
  let producer: import('kafkajs').Producer | null = null;
  try {
    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({
      clientId: 'nest-batch-probe',
      brokers: [`${host}:${port}`],
      connectionTimeout: 3000,
      requestTimeout: 30000,
    });
    producer = kafka.producer({ allowAutoTopicCreation: true });
    await producer.connect();
    await producer.send({
      topic: 'nest-batch-probe',
      messages: [{ key: 'probe', value: JSON.stringify({ ts: Date.now() }) }],
    });
    return { ok: true, reason: 'send() ok' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (producer) {
      try {
        await producer.disconnect();
      } catch {
        // ignore disconnect errors during probe
      }
    }
  }
}

/**
 * Per-test fixture: a Nest testing module compiled with the full
 * `@nest-batch/core` graph + `@nest-batch/kafka` module, with the
 * runtime bridge wired to talk to the local Kafka broker.
 */
export interface KafkaE2EFixture {
  moduleRef: import('@nestjs/core').TestingModule;
  launcher: import('@nest-batch/core').JobLauncher;
  strategy: import('@nest-batch/core').IExecutionStrategy;
  kafka: KafkaFixture;
}

/**
 * Build a Nest testing module wired to the local Kafka broker.
 */
export async function buildKafkaE2EModule(options: {
  kafka: KafkaFixture;
  /**
   * When `true`, the `@nest-batch/kafka` module does NOT start a
   * `Consumer` (so the test can drive the producer side in isolation).
   * Defaults to `false` — most tests want a consumer.
   */
  noConsumer?: boolean;
}): Promise<{ moduleRef: import('@nestjs/core').TestingModule }> {
  const { NestFactory } = await import('@nestjs/core');
  const core = await import('@nest-batch/core');
  const kafkaAdapter = await import('../src');

  const inMemoryPersistence: import('@nest-batch/core').BatchAdapter = {
    name: 'in-memory',
    module: {
      module: class InMemoryPersistenceModule {},
      global: true,
      providers: [
        {
          provide: core.InMemoryJobRepository,
          useFactory: () => new core.InMemoryJobRepository(),
        },
        {
          provide: core.InMemoryTransactionManager,
          useFactory: () => new core.InMemoryTransactionManager(),
        },
        { provide: core.JobRepository, useExisting: core.InMemoryJobRepository },
        { provide: core.TransactionManager, useExisting: core.InMemoryTransactionManager },
      ],
      exports: [
        core.InMemoryJobRepository,
        core.InMemoryTransactionManager,
        core.JobRepository,
        core.TransactionManager,
      ],
    },
    globalProviders: [
      { provide: core.JOB_REPOSITORY_TOKEN, useExisting: core.InMemoryJobRepository },
      { provide: core.TRANSACTION_MANAGER_TOKEN, useExisting: core.InMemoryTransactionManager },
      { provide: core.JobRepository, useExisting: core.InMemoryJobRepository },
      { provide: core.TransactionManager, useExisting: core.InMemoryTransactionManager },
    ],
  };

  const app = await NestFactory.createApplicationContext(
    {
      module: class TestRootModule {},
      global: true,
      imports: [
        core.NestBatchModule.forRoot({
          adapters: {
            persistence: inMemoryPersistence,
            transport: kafkaAdapter.KafkaAdapter.forRoot({
              connection: {
                brokers: [`${options.kafka.host}:${options.kafka.port}`],
                clientId: options.kafka.clientId,
              },
              autoStartConsumer: options.noConsumer === true ? false : true,
              topic: options.kafka.topic,
              consumerGroupId: options.kafka.consumerGroupId,
            }),
          },
        }),
      ],
    },
    { logger: ['error', 'warn'] },
  );

  await app.init();

  // Wait for the producer to be connected before returning.
  const kafkaSrc = await import('../src');
  const runtime = app.get(kafkaSrc.KafkaRuntimeService) as unknown as {
    producer: import('kafkajs').Producer | null;
    options: { topic: string };
  };
  if (runtime.producer) {
    // Poll until the producer is actually connected.  The eager
    // connect in `onApplicationBootstrap` may still be in flight
    // when the first test calls `launch()`.  We send a valid
    // JSON payload so the consumer doesn't crash on the probe.
    for (let i = 0; i < 50; i++) {
      try {
        await runtime.producer.send({
          topic: runtime.options.topic,
          messages: [
            {
              value: JSON.stringify({
                executionId: 'probe',
                jobExecutionId: 'probe',
                jobId: 'probe',
                stepId: 'probe',
              }),
            },
          ],
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('disconnected')) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          // Any other error (topic not ready, etc.) — give it one
          // more beat and try again.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  }

  return { moduleRef: app as unknown as import('@nestjs/core').TestingModule };
}

/**
 * Convenience: `it` wrapper that skips when Kafka is unreachable.
 */
export function itWithKafka(
  name: string,
  fn: (ctx: TestContext) => void | Promise<void>,
  options: { timeout?: number; requireKafka?: boolean } = {},
): void {
  const { timeout = 30_000, requireKafka = true } = options;
  vitestIt(
    name,
    async (ctx) => {
      if (requireKafka) {
        const availability = getKafkaAvailability();
        if (!availability.available) {
          process.stderr.write(
            `[skip] Kafka not available on ${KAFKA_E2E_HOST}:${KAFKA_E2E_PORT} — skipping "${name}". Reason: ${availability.reason}\n`,
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
 * Cached Kafka-availability result.
 */
let _kafkaAvailable: boolean | null = null;
let _kafkaSkipReason = 'gate not run yet';

export function setKafkaAvailability(available: boolean, reason: string): void {
  _kafkaAvailable = available;
  _kafkaSkipReason = reason;
}

export function getKafkaAvailability(): { available: boolean; reason: string } {
  if (_kafkaAvailable === null) {
    return { available: true, reason: 'gate not run; assuming available' };
  }
  return { available: _kafkaAvailable, reason: _kafkaSkipReason };
}

/**
 * Tracked Nest module references so `afterEach` can close them
 * deterministically.
 */
const _tracked: Array<() => Promise<void>> = [];

export function trackKafkaE2EModule(
  moduleRef: import('@nestjs/core').TestingModule,
): void {
  _tracked.push(() => moduleRef.close());
}

const CLOSE_TIMEOUT_MS = 3_000;

afterEach(async () => {
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
 * Mint a unique client id prefix that includes a per-test nonce.
 */
export function makeClientId(suiteName: string): string {
  return `e2e:${suiteName}:${process.pid}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Mint a unique topic name that includes a per-test nonce.
 */
export function makeTopic(suiteName: string): string {
  return `e2e-${suiteName}-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
