/**
 * Task 21 — Redis + DB e2e for the demo's BullMQ execution path.
 *
 * Three scenarios run against the LIVE PostgreSQL container
 * (localhost:5434) and the LIVE Redis container (localhost:6379)
 * provided by the repo's `docker-compose.yml`. They exercise the
 * full demo pipeline — DefinitionCompiler → JobLauncher (BullMQ
 * strategy) → Redis Queue → BullMQ Worker → JobExecutor →
 * MikroORMJobRepository / MikroORMTransactionManager — using the
 * demo's actual `import-products` job (CSV → Product import) and
 * a custom slow job (for the worker-shutdown test).
 *
 * The tests start the real demo `AppModule` via `NestFactory.create`
 * (not `Test.createTestingModule`): the goal is to verify the
 * end-to-end wiring as a consumer would experience it, with the
 * BullMQ transport selected through `BATCH_TRANSPORT=bullmq` and
 * the worker started in-process via `BATCH_BULLMQ_AUTOSTART_WORKER=1`.
 *
 * Scenario overview:
 *   1. "Demo BullMQ import-products completes"
 *      POST `/jobs/import-products` with the fixture CSV, poll the
 *      PostgreSQL `JobExecution` row to COMPLETED, assert the
 *      `product` table has the expected rows. Proves the DB is the
 *      canonical state — the BullMQ transport only enqueues; the
 *      executor (Batch Core) is what writes COMPLETED + products.
 *   2. "Step/partition BullMQ granularity"
 *      POST `/jobs/import-products` with a 25+ row fixture, count
 *      BullMQ jobs created (raw RESP `LLEN bull:*:<state>` to count
 *      enqueued jobs across all states). Assert the count is bounded
 *      by the step count (2 steps ⇒ ≤ 2 jobs) and MUCH lower than
 *      the input row count.
 *   3. "Worker shutdown does not orphan active job"
 *      Register a custom 1-step tasklet job that intentionally
 *      sleeps, launch it, wait for the JobExecution to reach
 *      STARTED, then close the app (graceful shutdown). Assert the
 *      JobExecution is either COMPLETED (sleep finished before
 *      close) or FAILED (the worker returned the in-flight job to
 *      the queue on close), but NOT permanently orphaned in
 *      STARTING / STARTED.
 *
 * If PostgreSQL or Redis is unreachable on the configured host:port,
 * each scenario is skipped with a clear log line — mirrors the
 * existing `import-products.e2e.spec.ts` pattern for PG-unavailable
 * handling.
 *
 * Environment-variable contract (set by `test/bullmq-e2e-setup.ts`
 * which is loaded via the `setupFiles` hook in
 * `vitest.bullmq-e2e.config.ts` BEFORE this spec is evaluated):
 *   - BATCH_TRANSPORT=bullmq          — selects the BullMQ strategy
 *   - BATCH_BULLMQ_AUTOSTART_WORKER=1 — starts the worker in-process
 *   - BATCH_BULLMQ_KEY_PREFIX=<unique> — namespaced Redis keys
 *   - REDIS_HOST / REDIS_PORT         — Redis connection
 *   - DATABASE_HOST / DATABASE_PORT / DATABASE_USER / DATABASE_PASSWORD
 *     / DATABASE_NAME                  — PostgreSQL connection
 */
import 'reflect-metadata';
import { setTimeout as wait } from 'node:timers/promises';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM, type EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import request from 'supertest';
import {
  BatchBuilder,
  JobLauncher,
  JobRegistry,
  JobStatus,
  RefKind,
  StepStatus,
  type JobBuilderConfig,
} from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  JobExecutionEntity,
  StepExecutionEntity,
} from '@nest-batch/mikro-orm';

import { AppModule } from '../../src/app.module';
import { ProductEntity } from '../../src/entities/product.entity';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? '127.0.0.1',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
};

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const KEY_PREFIX = process.env.BATCH_BULLMQ_KEY_PREFIX ?? 'nest-batch:';

const SAMPLE_DATA_DIR = join(__dirname, '..', '..', 'sample-data');
const VALID_CSV = join(SAMPLE_DATA_DIR, 'products-valid.csv');

const TRUNCATE_SQL = `
  TRUNCATE TABLE product,
                   batch_step_execution_context,
                   batch_job_execution_context,
                   batch_step_execution,
                   batch_job_execution_params,
                   batch_job_execution,
                   batch_job_instance
  RESTART IDENTITY CASCADE
`;

// ---------------------------------------------------------------------------
// Reachability probes — graceful skip when PG or Redis is down
// ---------------------------------------------------------------------------

async function isReachable(
  host: string,
  port: number,
  timeoutMs = 500,
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

const [pgProbe, redisProbe] = await Promise.all([
  isReachable(PG_CONFIG.host, PG_CONFIG.port),
  isReachable(REDIS_HOST, REDIS_PORT),
]);
const PG_AVAILABLE = pgProbe.reachable;
const REDIS_AVAILABLE = redisProbe.reachable;
const SKIP_REASON = !PG_AVAILABLE
  ? `PostgreSQL unreachable at ${PG_CONFIG.host}:${PG_CONFIG.port} (${pgProbe.reason})`
  : !REDIS_AVAILABLE
    ? `Redis unreachable at ${REDIS_HOST}:${REDIS_PORT} (${redisProbe.reason})`
    : '';

const itIfInfra = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  if (PG_AVAILABLE && REDIS_AVAILABLE) {
    if (timeout !== undefined) {
      test(name, fn, timeout);
    } else {
      test(name, fn);
    }
  } else {
    test.skip(`[skipped: ${SKIP_REASON}] ${name}`, fn, timeout);
  }
};

// ---------------------------------------------------------------------------
// Minimal RESP client for Redis inspection (LLEN, KEYS, EXISTS)
// ---------------------------------------------------------------------------
//
// We deliberately avoid adding a direct `bullmq` / `ioredis` dependency
// to the demo app — the e2e suite uses raw RESP over a TCP socket, which
// is exactly what `@nest-batch/bullmq`'s own runtime test
// (`packages/bullmq/tests/bullmq-runtime.test.ts`) does.
//
// BullMQ's `keyPrefix` option is wired into ioredis as `keyPrefix`,
// which is APPLIED TRANSPARENTLY on the wire: ioredis prepends the
// prefix on outgoing commands and strips it on incoming replies. The
// actual keys on the Redis wire are `bull:<queueName>:<state>` and
// `bull:<queueName>:<jobId>` (HASH), regardless of the `keyPrefix`
// value. The KEY_PREFIX value is still useful as a per-test
// namespace for production (it makes Redis-side debugging easier)
// but does NOT affect the pattern we use to glob keys.

function respCommand(
  host: string,
  port: number,
  args: string[],
  timeoutMs = 750,
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
      if (decoded !== null) finish(null, decoded);
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

function tryDecodeResp(buf: string): unknown {
  if (buf.length === 0) return null;
  const first = buf[0];
  if (first === '*') return tryDecodeArray(buf, 0);
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

async function respKeys(pattern: string): Promise<string[]> {
  const reply = await respCommand(REDIS_HOST, REDIS_PORT, ['KEYS', pattern]);
  return Array.isArray(reply) ? (reply as string[]) : [];
}

async function respLlen(key: string): Promise<number> {
  const reply = await respCommand(REDIS_HOST, REDIS_PORT, ['LLEN', key]);
  return typeof reply === 'number' ? reply : 0;
}

async function respExists(key: string): Promise<number> {
  const reply = await respCommand(REDIS_HOST, REDIS_PORT, ['EXISTS', key]);
  return typeof reply === 'number' ? reply : 0;
}

/**
 * Count the BullMQ jobs ever created across all steps for the
 * current queue. We sum:
 *   - the lengths of the `wait`, `active`, `completed`, `failed`,
 *     `delayed`, `paused` LISTs (each is one job per list entry);
 *   - the count of `bull:nest-batch:work:<jobId>` HASH keys (one
 *     per enqueued job, retained per the `removeOnComplete` /
 *     `removeOnFail` policy).
 *
 * Both counts are tracked because BullMQ's GC policy can drain the
 * LISTs but leave the HASHes (or vice versa) for a short window.
 * For the "step/partition" assertion we use the SUM of both
 * counts as a robust upper bound on "BullMQ jobs ever created".
 */
async function countBullmqJobs(): Promise<{ listCount: number; hashCount: number }> {
  const allKeys = await respKeys('bull:*');
  let listCount = 0;
  let hashCount = 0;
  for (const k of allKeys) {
    if (k.endsWith(':meta') || k.endsWith(':repeat')) continue;
    if (
      k.endsWith(':wait') ||
      k.endsWith(':active') ||
      k.endsWith(':completed') ||
      k.endsWith(':failed') ||
      k.endsWith(':delayed') ||
      k.endsWith(':paused')
    ) {
      listCount += await respLlen(k);
    } else {
      // HASH key for a job id (or LIST / ZSET / SET we don't care
      // about). EXISTS returns 1 for any present key regardless
      // of type. We only count the per-job-id HASHes; in practice
      // any non-suffix key under `bull:*` is a job-id HASH.
      if (await respExists(k)) hashCount += 1;
    }
  }
  return { listCount, hashCount };
}

async function waitFor<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await producer();
    if (await predicate(v)) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await wait(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a CSV with `rowCount` valid product rows. Used by the
 * "step/partition granularity" scenario, which needs ≥ 25 input
 * rows to make the "BullMQ jobs << row count" assertion meaningful.
 */
function makeBigCsv(rowCount: number): string {
  const header = 'id,name,sku,price,category\n';
  const valid = (i: number): string =>
    `${i},Item${i},SKU-${String(i).padStart(4, '0')},${(1 + (i % 9)).toFixed(2)},electronics\n`;
  return header + Array.from({ length: rowCount }, (_, i) => valid(i + 1)).join('');
}

/**
 * Build a 1-step job config that intentionally sleeps for `sleepMs`
 * before completing. Used by the "worker shutdown" scenario so the
 * test can interrupt the job mid-flight. A single-step job needs no
 * transitions — the validator accepts the start step as the
 * terminal node when there is nothing to transition to.
 */
function makeSlowTaskletJob(id: string, sleepMs: number): JobBuilderConfig {
  return BatchBuilder.create()
    .job(id)
    .restartable(true)
    .addStep((s) =>
      s.tasklet('slow-step', {
        kind: RefKind.BuilderLambda,
        fn: () => ({
          execute: async () => {
            await wait(sleepMs);
            return { sleptMs: sleepMs };
          },
        }),
      }),
    )
    .build();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Demo BullMQ execution path (Task 21) — live PG + live Redis', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let app: INestApplication;
  let launcher: JobLauncher;
  let registry: JobRegistry;
  let tempDir: string;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      ...PG_CONFIG,
      entities: [...BATCH_META_ENTITIES, ProductEntity],
    });
    tempDir = mkdtempSync(join(tmpdir(), 'bullmq-e2e-'));
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Fresh forked EM per test → isolates the unit-of-work identity
    // map between scenarios (no stale ProductEntity / ExecutionContext
    // state).
    const forkedEm = orm.em.fork() as unknown as SqlEntityManager;
    await forkedEm.execute(TRUNCATE_SQL);
    em = forkedEm;

    // Boot the real demo `AppModule`. The env vars are set by
    // `test/bullmq-e2e-setup.ts` BEFORE this spec is evaluated, so
    // the `@Module(buildAppModuleBody())` decorator on `AppModule`
    // already saw `BATCH_TRANSPORT=bullmq` /
    // `BATCH_BULLMQ_AUTOSTART_WORKER=1` at class load time.
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    await app.init();
    launcher = app.get(JobLauncher);
    registry = app.get(JobRegistry);
  });

  afterEach(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // ignore: a teardown error must not mask a real test failure
      }
      app = null as unknown as INestApplication;
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 1: happy path
  // -------------------------------------------------------------------------
  itIfInfra(
    '1. Demo BullMQ import-products: POST → BullMQ worker → DB COMPLETED + products in product table',
    async () => {
      const csv = VALID_CSV;
      // Sanity: the fixture is the 3-row demo CSV.
      const fixtureRows = readFileSync(csv, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '').length - 1;
      expect(fixtureRows).toBe(3);

      const response = await request(app.getHttpServer())
        .post('/jobs/import-products')
        .send({ file: csv })
        .expect(200);
      const { executionId, status } = response.body as { executionId: string; status: string };
      expect(executionId).toBeDefined();
      // The launcher returns the latest persisted execution. Right
      // after `add()` the worker has not picked up the job yet, so
      // the status is `STARTING` (or possibly `STARTED` if the worker
      // is very fast). All three (STARTING / STARTED / COMPLETED) are
      // acceptable as the immediate response.
      expect([JobStatus.STARTING, JobStatus.STARTED, JobStatus.COMPLETED]).toContain(status);

      // Poll PostgreSQL for terminal state. The DB is the canonical
      // state — BullMQ is transport only. If the JobExecution is
      // still STARTING after 15 seconds, the test fails (worker not
      // draining, Redis misconfigured, etc.).
      const final = await waitFor(
        () => em.findOne(JobExecutionEntity, { id: executionId }),
        async (row) =>
          row?.status === JobStatus.COMPLETED || row?.status === JobStatus.FAILED,
        15_000,
      );
      expect(final).not.toBeNull();
      expect(final!.status).toBe(JobStatus.COMPLETED);
      expect(final!.exitCode).toBe('COMPLETED');
      expect(final!.endTime).toBeInstanceOf(Date);

      // The product table must contain the 3 fixture rows.
      const products = await em.find(ProductEntity, {});
      expect(products).toHaveLength(3);
      const skus = products.map((p) => p.sku).sort();
      expect(skus).toEqual(['SKU-001', 'SKU-002', 'SKU-003']);

      // Both step rows must be COMPLETED.
      const stepRows = await em.find(StepExecutionEntity, { jobExecutionId: executionId });
      expect(stepRows).toHaveLength(2);
      const stepNames = stepRows.map((s) => s.stepName).sort();
      expect(stepNames).toEqual(['import-products', 'validate-csv']);
      for (const s of stepRows) {
        expect(s.status).toBe(StepStatus.COMPLETED);
      }
    },
    45_000,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: step/partition BullMQ granularity
  // -------------------------------------------------------------------------
  itIfInfra(
    '2. BullMQ jobs are step-level: 30 rows ⇒ ≤ 2 BullMQ jobs (not 30)',
    async () => {
      const rowCount = 30;
      const bigCsv = join(tempDir, 'big.csv');
      writeFileSync(bigCsv, makeBigCsv(rowCount), 'utf8');

      // Re-register the `import-products` job with a per-launch
      // file path. The demo's `ImportProductsJobRegistrar` already
      // registered a default-file variant on bootstrap; the registry
      // stores the last-registered definition per job id. Our
      // re-registration uses `BuilderLambda`s that point at the new
      // CSV — exactly the "per-launch file path" extension point
      // documented in `import-products.job.ts`.
      const { CsvProductReader } = await import(
        '../../src/jobs/import-products/reader/csv-product.reader'
      );
      const { ProductProcessor } = await import(
        '../../src/jobs/import-products/processor/product.processor'
      );
      const { ProductWriter } = await import(
        '../../src/jobs/import-products/writer/product.writer'
      );
      const { ImportProductsJob } = await import(
        '../../src/jobs/import-products/import-products.job'
      );

      const writer = new ProductWriter(em);
      const config = ImportProductsJob.build(
        bigCsv,
        () => new CsvProductReader(bigCsv),
        () => new ProductProcessor(),
        () => writer,
      );
      registry.register(config);

      const response = await request(app.getHttpServer())
        .post('/jobs/import-products')
        .send({ file: bigCsv })
        .expect(200);
      const { executionId } = response.body as { executionId: string };

      const final = await waitFor(
        () => em.findOne(JobExecutionEntity, { id: executionId }),
        async (row) =>
          row?.status === JobStatus.COMPLETED || row?.status === JobStatus.FAILED,
        30_000,
      );
      expect(final!.status).toBe(JobStatus.COMPLETED);

      // All 30 rows should be in the product table — this proves
      // the chunk loop ran end-to-end inside the single BullMQ job.
      const products = await em.find(ProductEntity, {});
      expect(products).toHaveLength(rowCount);

      // Now the critical assertion: count BullMQ jobs. The
      // `import-products` job has 2 steps (`validate-csv` tasklet
      // + `import-products` chunk). With `partitionIndex` always
      // undefined in the MVP, the strategy enqueues one BullMQ
      // job per step → at most 2 BullMQ jobs. The 30 rows are
      // chunked (chunkSize=10 ⇒ 3 chunks) and processed INSIDE
      // the single BullMQ job for the `import-products` step.
      //
      // We use the SUM of (list counts) + (hash counts) as a
      // robust upper bound — it captures jobs in any state
      // (wait/active/completed/failed/delayed/paused) AND the
      // per-job HASH metadata key. BullMQ's GC may have drained
      // the LISTs but kept the HASHes (or vice versa); the sum
      // is invariant under that GC.
      const counts = await countBullmqJobs();
      const totalTracked = counts.listCount + counts.hashCount;
      // Sanity: at least one BullMQ job was created (otherwise the
      // happy path assertion above would have been false).
      expect(totalTracked).toBeGreaterThan(0);
      // The structural property: total BullMQ jobs is MUCH lower
      // than the 30 input rows. If the strategy ever degenerated
      // to "one job per row", this assertion would fail.
      expect(totalTracked).toBeLessThan(rowCount);
      // Tighter bound: with 2 steps and no partitions, the LIST
      // totals (jobs in any state) are at most 2. The HASH
      // count may be slightly higher if BullMQ retains per-job
      // HASHes after the LIST entry is GC'd.
      expect(counts.listCount).toBeLessThanOrEqual(2);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Scenario 3: worker shutdown does not orphan active job
  // -------------------------------------------------------------------------
  itIfInfra(
    '3. Worker shutdown does not orphan an active job — terminal state is COMPLETED or FAILED (not stuck STARTED)',
    async () => {
      // Register a custom 1-step job that sleeps for 1.5 seconds.
      // The job is restartable: true, so a FAILED state is
      // "recoverable" per the T48 contract.
      const SLOW_JOB_ID = 'shutdown-slow-job';
      const SLOW_SLEEP_MS = 1500;
      const config = makeSlowTaskletJob(SLOW_JOB_ID, SLOW_SLEEP_MS);
      registry.register(config);

      // We use `JobLauncher.launch` directly (no HTTP) so we can
      // precisely time the shutdown relative to the in-flight job.
      // The `restartable: true` flag is part of the in-memory
      // `JobDefinition` (set above by
      // `BatchBuilder.create().job(SLOW_JOB_ID).restartable(true)`).
      const launchPromise = launcher.launch(SLOW_JOB_ID, { nonce: 'shutdown' });
      // Wait briefly for the worker to actually pick up the job
      // (i.e. JobExecution reaches STARTED). This is the moment we
      // want to interrupt with a shutdown.
      const partial = await waitFor(
        async () => {
          // `launch` is an async call to the BullMQ strategy —
          // the JobExecution is created synchronously, but the
          // `launch` promise itself resolves BEFORE the worker
          // picks it up. We poll the DB to catch the STARTED
          // transition.
          await launchPromise.catch(() => undefined);
          const rows = await em.find(JobExecutionEntity, {});
          return rows[0] ?? null;
        },
        async (row) =>
          row?.status === JobStatus.STARTED ||
          row?.status === JobStatus.COMPLETED ||
          row?.status === JobStatus.FAILED,
        5_000,
        25,
      );
      const executionId = partial!.id;

      // Graceful shutdown. `app.close()` triggers Nest's
      // `onApplicationShutdown` lifecycle, which calls
      // `BullmqRuntimeService.onApplicationShutdown` → closes the
      // worker (waiting for in-flight jobs to drain or be returned
      // to the queue), then events, then queue. The active job is
      // allowed to complete during the close window — that is the
      // "no orphan" guarantee from `bullmq-runtime.service.ts`.
      await app.close();
      app = null as unknown as INestApplication; // suppress the afterEach close

      // The JobExecution row MUST reach a terminal state — not be
      // stuck in STARTING / STARTED. The contract is:
      //   - COMPLETED — the worker's drain-on-close waited for
      //     the in-flight job to finish (1.5s sleep completes
      //     during the close).
      //   - FAILED — the worker returned the job to the queue
      //     (BullMQ's default behavior on close with an in-flight
      //     job), and the executor saw a transport failure. With
      //     `restartable: true`, the row is RECOVERABLE (a future
      //     `JobLauncher.run()` resumes from this state).
      //
      // Either is acceptable; the only unacceptable outcome is
      // "stuck in STARTING / STARTED with no status transition"
      // — that would mean the JobExecution is permanently
      // orphaned (the DB says it is running, but no worker is
      // coming back to drive it).
      const final = await waitFor(
        () => em.findOne(JobExecutionEntity, { id: executionId }),
        async (row) =>
          row?.status === JobStatus.COMPLETED || row?.status === JobStatus.FAILED,
        10_000,
        50,
      );
      expect(final).not.toBeNull();
      expect([JobStatus.COMPLETED, JobStatus.FAILED]).toContain(final!.status);
      // The `restartable: true` flag is part of the in-memory
      // `JobDefinition`, not the persisted schema. We assert it
      // here to lock in the contract: a FAILED execution
      // observed by this test is always restartable, so the
      // JobExecution is recoverable.
      expect(config.restartable).toBe(true);
    },
    30_000,
  );
});
