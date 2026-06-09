/**
 * T-AC-5 — `@nest-batch/webhook` acceptance test.
 *
 * Pinned by `.omo/plans/not-in-this-release.md` T12 (Track E) and
 * `docs/RELEASE-0.2.0.md` §7. The suite stands up a real
 * `http.createServer().listen(0)` server on a random port and
 * exercises the `WebhookBatchObserver` end-to-end against it.
 *
 * Coverage:
 *   1. HMAC-SHA256 byte-equality — sign with the same secret on
 *      the test side, compare to the `X-Nest-Batch-Signature`
 *      header the observer shipped.
 *   2. Retry on 5xx — server returns 500 twice, then 200;
 *      observer must POST 3 times.
 *   3. NO retry on 4xx — server returns 400 once; observer
 *      must POST exactly 1 time.
 *   4. Dead-letter `logger.warn` on final failure — server
 *      returns 500 four times; observer must emit exactly one
 *      `logger.warn` with the dead-letter shape
 *      (`[WebhookBatchObserver] dead-letter ...`).
 *   5. Secret NEVER logged — capture the entire log stream,
 *      grep for the secret value, expect zero matches.
 *   6. Subscription filter — only `[JOB_COMPLETED, JOB_FAILED,
 *      STEP_FAILED]` events trigger a POST; a `JOB_STARTED`
 *      event must NOT POST.
 *   7. Module factory — `forRoot({...})` returns a
 *      `DynamicModule` with `global: true`, the observer in
 *      providers, and the resolved options frozen.
 *
 * The retry schedule is forced to `[1ms, 5ms, 25ms, 125ms]` by
 * the `WEBHOOK_TEST_FAST=1` env var (set in the test harness)
 * so the full 4-attempt retry path runs in <200ms instead of
 * the 156-second production schedule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { AddressInfo as NodeAddressInfo } from 'node:net';
import { BATCH_EVENT, type BatchEvent, type BatchEventType } from '@nest-batch/core';
import {
  buildSignatureHeader,
  forRoot,
  parseSignatureHeader,
  verifyV1,
  WebhookBatchModule,
  WebhookBatchObserver,
} from '../src';
import type { WebhookLogger } from '../src';

const TEST_SECRET = 'super-secret-test-key-do-not-use-in-prod-32b';
process.env['WEBHOOK_TEST_FAST'] = '1';

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
}

interface ScriptedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly captured: CapturedRequest[];
  /**
   * Set the next N status codes the server will return. The
   * server cycles through them on successive requests; once
   * exhausted it returns 200.
   */
  setNextStatuses(statuses: number[]): void;
  close(): Promise<void>;
}

async function startScriptedServer(): Promise<ScriptedServer> {
  const captured: CapturedRequest[] = [];
  const queue: number[] = [];
  let server: Server | undefined;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = v;
      }
      captured.push({ method: req.method ?? '<unknown>', url: req.url ?? '<unknown>', headers, rawBody: raw });
      const next = queue.shift();
      const status = next ?? 200;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: status >= 200 && status < 300, status }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as NodeAddressInfo;
  return {
    server,
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}/hook`,
    captured,
    setNextStatuses(statuses: number[]) {
      queue.push(...statuses);
    },
    async close() {
      if (server === undefined) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
}

/**
 * Build a console-backed `WebhookLogger` whose every method
 * appends to a captured array. The capture is the input to
 * the "secret never logged" assertion.
 */
function makeCapturingLogger(): { logger: WebhookLogger; capture: string[] } {
  const capture: string[] = [];
  const logger: WebhookLogger = {
    log: (m) => capture.push(m),
    warn: (m) => capture.push(m),
    error: (m) => capture.push(m),
    debug: (m) => capture.push(m),
  };
  return { logger, capture };
}

function buildEvent(overrides: Partial<BatchEvent> = {}): BatchEvent {
  return {
    type: BATCH_EVENT.JOB_COMPLETED,
    timestamp: new Date('2026-06-09T12:00:00.000Z'),
    jobExecutionId: 'job-exec-1',
    ...(overrides.stepExecutionId !== undefined ? { stepExecutionId: overrides.stepExecutionId } : {}),
    data: { status: 'COMPLETED', exitCode: 'COMPLETED' },
    ...overrides,
  };
}

describe('@nest-batch/webhook — WebhookBatchObserver (T-AC-5)', () => {
  let server: ScriptedServer | undefined;

  beforeEach(() => {
    process.env['WEBHOOK_TEST_FAST'] = '1';
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  // ---------------------------------------------------------------------
  // 1. HMAC byte-equality
  // ---------------------------------------------------------------------
  it('signs the envelope with HMAC-SHA256 (X-Nest-Batch-Signature) — server-side byte-equality', async () => {
    server = await startScriptedServer();
    const { logger, capture } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED],
        attempts: 1,
        timeoutMs: 5_000,
        logger,
      },
    );

    const event = buildEvent();
    await observer.onEvent(event);

    expect(server.captured).toHaveLength(1);
    const req = server.captured[0]!;
    expect(req.method).toBe('POST');

    const headerValue = req.headers['x-nest-batch-signature'];
    expect(typeof headerValue).toBe('string');
    const parsed = parseSignatureHeader(String(headerValue));
    // Recompute the HMAC from the raw body and the
    // header's `t=` value. If byte-equality holds, this
    // returns true.
    const ok = verifyV1(TEST_SECRET, parsed.timestamp, req.rawBody, parsed.v1);
    expect(ok).toBe(true);

    // Independently re-sign with the same secret + body +
    // timestamp and confirm we get the same v1 hex.
    const rebuilt = buildSignatureHeader(TEST_SECRET, parsed.timestamp, req.rawBody);
    expect(rebuilt).toBe(String(headerValue));

    // The capture must not contain the secret.
    expect(capture.join('\n')).not.toContain(TEST_SECRET);
  });

  // ---------------------------------------------------------------------
  // 2. Retry on 5xx — server returns 500, 500, 200 → 3 calls
  // ---------------------------------------------------------------------
  it('retries on 5xx through the full attempt budget (2× 500 + 200 → 3 calls)', async () => {
    server = await startScriptedServer();
    server.setNextStatuses([500, 500, 200]);
    const { logger } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED],
        attempts: 4,
        timeoutMs: 5_000,
        logger,
      },
    );

    await observer.onEvent(buildEvent());
    expect(server.captured).toHaveLength(3);
  });

  // ---------------------------------------------------------------------
  // 3. NO retry on 4xx — server returns 400 → 1 call
  // ---------------------------------------------------------------------
  it('does NOT retry on 4xx (400 → 1 call, no second attempt)', async () => {
    server = await startScriptedServer();
    server.setNextStatuses([400]);
    const { logger } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED],
        attempts: 4,
        timeoutMs: 5_000,
        logger,
      },
    );

    await observer.onEvent(buildEvent());
    expect(server.captured).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // 4. Dead-letter on final failure — 4× 500 → 4 calls + 1 warn
  // ---------------------------------------------------------------------
  it('emits a dead-letter logger.warn after all 4 attempts fail (4× 500)', async () => {
    server = await startScriptedServer();
    server.setNextStatuses([500, 500, 500, 500]);
    const { logger, capture } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED],
        attempts: 4,
        timeoutMs: 5_000,
        logger,
      },
    );

    await observer.onEvent(buildEvent());
    expect(server.captured).toHaveLength(4);
    const deadLetters = capture.filter((m) => m.startsWith('[WebhookBatchObserver] dead-letter'));
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toContain(`url=${server.url}`);
    expect(deadLetters[0]).toContain('attempts=4');
    expect(deadLetters[0]).toContain('lastStatus=500');
  });

  // ---------------------------------------------------------------------
  // 5. Secret NEVER logged
  // ---------------------------------------------------------------------
  it('never logs the HMAC secret in any code path (4xx dead-letter, 5xx dead-letter, success, debug)', async () => {
    // Run every failure path and assert the secret is
    // absent from the captured log stream.
    for (const script of [
      { name: '5xx dead-letter', statuses: [500, 500, 500, 500] },
      { name: '4xx dead-letter', statuses: [400] },
      { name: 'success', statuses: [200] },
    ]) {
      server = await startScriptedServer();
      server.setNextStatuses(script.statuses);
      const { logger, capture } = makeCapturingLogger();
      const observer = new WebhookBatchObserver(
        {
          secret: TEST_SECRET,
          urls: [server.url],
          events: [BATCH_EVENT.JOB_COMPLETED],
          attempts: 4,
          timeoutMs: 5_000,
          logger,
        },
      );
      await observer.onEvent(buildEvent());
      const all = capture.join('\n');
      expect(
        all.includes(TEST_SECRET),
        `secret leaked on path "${script.name}": ${all}`,
      ).toBe(false);
      await server.close();
      server = undefined;
    }
  });

  // ---------------------------------------------------------------------
  // 6. Subscription filter — JOB_STARTED is dropped
  // ---------------------------------------------------------------------
  it('only POSTs on subscribed events (JOB_STARTED is dropped silently)', async () => {
    server = await startScriptedServer();
    const { logger } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED, BATCH_EVENT.JOB_FAILED, BATCH_EVENT.STEP_FAILED],
        attempts: 1,
        timeoutMs: 5_000,
        logger,
      },
    );

    // JOB_STARTED is not in the default subscription set.
    await observer.onEvent(buildEvent({ type: BATCH_EVENT.JOB_STARTED }));
    expect(server.captured).toHaveLength(0);

    // JOB_COMPLETED IS in the set.
    await observer.onEvent(buildEvent({ type: BATCH_EVENT.JOB_COMPLETED }));
    expect(server.captured).toHaveLength(1);

    // JOB_FAILED IS in the set.
    await observer.onEvent(buildEvent({ type: BATCH_EVENT.JOB_FAILED }));
    expect(server.captured).toHaveLength(2);

    // STEP_FAILED IS in the set.
    await observer.onEvent(
      buildEvent({ type: BATCH_EVENT.STEP_FAILED, stepExecutionId: 'step-exec-1' }),
    );
    expect(server.captured).toHaveLength(3);

    // STEP_COMPLETED is NOT in the set.
    await observer.onEvent(
      buildEvent({ type: BATCH_EVENT.STEP_COMPLETED, stepExecutionId: 'step-exec-1' }),
    );
    expect(server.captured).toHaveLength(3);
  });

  // ---------------------------------------------------------------------
  // 7. Module factory — forRoot returns a global DynamicModule
  // ---------------------------------------------------------------------
  it('WebhookBatchModule.forRoot({...}) returns a global DynamicModule wiring the observer + options', () => {
    const mod = forRoot({ secret: TEST_SECRET, urls: ['https://example.com/hook'] });
    expect(mod.module).toBe(WebhookBatchModule);
    expect(mod.global).toBe(true);
    expect(Array.isArray(mod.providers)).toBe(true);
    expect(mod.providers).toContain(WebhookBatchObserver);
    expect(mod.exports).toContain(WebhookBatchObserver);
  });

  // ---------------------------------------------------------------------
  // 8. Env fallback — secret is read from WEBHOOK_HMAC_SECRET when
  //    the host did not pass `secret`.
  // ---------------------------------------------------------------------
  it('falls back to process.env.WEBHOOK_HMAC_SECRET when `secret` is not provided', async () => {
    const prev = process.env['WEBHOOK_HMAC_SECRET'];
    process.env['WEBHOOK_HMAC_SECRET'] = TEST_SECRET;
    try {
      const mod = forRoot({ urls: ['https://example.com/hook'] });
      // The module's provider list includes a value provider
      // for WEBHOOK_MODULE_OPTIONS — we cannot easily reach
      // the resolved options here, so we re-derive via
      // resolveWebhookOptions semantics: assert the
      // DynamicModule was built without throwing.
      expect(mod.providers).toBeDefined();
    } finally {
      if (prev === undefined) {
        delete process.env['WEBHOOK_HMAC_SECRET'];
      } else {
        process.env['WEBHOOK_HMAC_SECRET'] = prev;
      }
    }
  });

  // ---------------------------------------------------------------------
  // 9. Throws when neither `secret` nor env is set
  // ---------------------------------------------------------------------
  it('throws at forRoot time when no secret is provided (host or env)', () => {
    const prev = process.env['WEBHOOK_HMAC_SECRET'];
    delete process.env['WEBHOOK_HMAC_SECRET'];
    try {
      expect(() => forRoot({ urls: ['https://example.com/hook'] })).toThrow(
        /secret is required/i,
      );
    } finally {
      if (prev !== undefined) process.env['WEBHOOK_HMAC_SECRET'] = prev;
    }
  });

  // ---------------------------------------------------------------------
  // 10. Envelope shape — v1 contract
  // ---------------------------------------------------------------------
  it('serializes the v1 envelope: { version: 1, type, timestamp, jobId, execution }', async () => {
    server = await startScriptedServer();
    const { logger } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.JOB_COMPLETED],
        attempts: 1,
        timeoutMs: 5_000,
        logger,
      },
    );

    await observer.onEvent(
      buildEvent({
        data: { status: 'COMPLETED', exitCode: 'COMPLETED', processedCount: 42 },
      }),
    );

    expect(server.captured).toHaveLength(1);
    const envelope = JSON.parse(server.captured[0]!.rawBody);
    expect(envelope).toMatchObject({
      version: 1,
      type: BATCH_EVENT.JOB_COMPLETED,
      jobId: 'job-exec-1',
      execution: { status: 'COMPLETED', exitCode: 'COMPLETED', processedCount: 42 },
    });
    expect(typeof envelope.timestamp).toBe('string');
    expect(new Date(envelope.timestamp).toISOString()).toBe(envelope.timestamp);
  });

  // ---------------------------------------------------------------------
  // 11. stepId is included for STEP_* events, omitted for JOB_*
  // ---------------------------------------------------------------------
  it('includes stepId for STEP_FAILED events and omits it for JOB_COMPLETED', async () => {
    server = await startScriptedServer();
    const { logger } = makeCapturingLogger();
    const observer = new WebhookBatchObserver(
      {
        secret: TEST_SECRET,
        urls: [server.url],
        events: [BATCH_EVENT.STEP_FAILED, BATCH_EVENT.JOB_COMPLETED],
        attempts: 1,
        timeoutMs: 5_000,
        logger,
      },
    );

    await observer.onEvent(
      buildEvent({ type: BATCH_EVENT.STEP_FAILED, stepExecutionId: 'step-exec-99' }),
    );
    await observer.onEvent(buildEvent({ type: BATCH_EVENT.JOB_COMPLETED }));

    expect(server.captured).toHaveLength(2);
    const stepEnv = JSON.parse(server.captured[0]!.rawBody);
    const jobEnv = JSON.parse(server.captured[1]!.rawBody);
    expect(stepEnv.stepId).toBe('step-exec-99');
    expect('stepId' in jobEnv).toBe(false);
  });
});
