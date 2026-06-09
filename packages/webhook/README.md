# `@nest-batch/webhook`

Webhook delivery observer for
[`@nest-batch/core`](../core). The package ships a
`WebhookBatchObserver` that subscribes to the `BATCH_EVENT.*`
lifecycle stream and POSTs an HMAC-SHA256-signed JSON envelope
to one or more URLs, with exponential-backoff retry on
5xx / network errors, a `logger.warn` dead-letter on final
failure, and a hard `no retry on 4xx` rule.

> **The observer is transport-agnostic.** It signs + POSTs
> envelopes; it does not care whether the job was driven by
> BullMQ, Kafka, or the in-process strategy. Any transport
> package that bridges `QueueEvents` (or equivalent) to the
> `BatchObserver.onEvent` entry point will deliver events to
> this observer without any extra wiring on the host's side.

The package is a **sibling**, not a replacement. The dependency
direction is strict and one-way:

```
@nest-batch/webhook  ──▶  @nest-batch/core
        │
        └──────────────▶  @nestjs/common, @nestjs/core (peer)
```

`@nest-batch/core` does not know this package exists. It
cannot — the boundary is enforced by
[`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`](../core/tests/core/boundary/no-forbidden-imports.test.ts),
which scans the core source tree and fails the build if a
forbidden package — `bullmq`, `kafkajs`, `mikro-orm`, `typeorm`,
`drizzle-orm`, `cron` — appears as a core import.

The observer uses **native `fetch`** (Node 20+). No HTTP client
(`undici` / `axios` / `node-fetch`) is added as a peer dep —
the host does not need to ship a separate HTTP library to
enable webhook delivery. `AbortController` provides the
per-attempt timeout.

---

## Install

```bash
pnpm add @nest-batch/webhook
```

Peer dependencies the host must already provide:

| Package            | Range         |
| ------------------ | ------------- |
| `@nest-batch/core` | `workspace:*` |
| `@nestjs/common`   | `^10 \|\| ^11` |
| `@nestjs/core`     | `^10 \|\| ^11` |

Node 20+ is required for the native `fetch` / `AbortController`
runtime. Older Node versions are not supported.

---

## Peer dependencies

| Package            | Range           | Notes                                                                                  |
| ------------------ | --------------- | -------------------------------------------------------------------------------------- |
| `@nest-batch/core` | `workspace:*`   | The batch engine. The observer only consumes the `BatchObserver` / `BATCH_EVENT` surface. |
| `@nestjs/common`   | `^10 \|\| ^11`  | For `@Module` / `Module` / injection tokens. Nest 10 and 11 are both supported.        |
| `@nestjs/core`     | `^10 \|\| ^11`  | Peer-declared for the dynamic-module surface; not used at runtime.                      |

The package deliberately does **not** declare a peer dep on
`undici` / `axios` / `node-fetch`. Webhook delivery uses the
runtime's built-in `fetch` + `AbortController` (Node 20+). Hosts
that prefer a different HTTP client can monkey-patch the global
`fetch` at bootstrap time, but no such override is necessary in
the common case.

---

## Wiring

```ts
import { Module } from '@nestjs/common';
import { NestBatchModule } from '@nest-batch/core';
import { BullmqAdapter } from '@nest-batch/bullmq';
import { WebhookBatchModule } from '@nest-batch/webhook';

@Module({
  imports: [
    NestBatchModule.forRoot({
      // ... your persistence + transport adapters
    }),
    BullmqAdapter.forRoot({
      connection: { host: process.env.REDIS_HOST, port: 6379 },
      autoStartWorker: true,
    }),
    WebhookBatchModule.forRoot({
      secret: process.env.WEBHOOK_HMAC_SECRET, // 32+ bytes recommended
      urls: [
        'https://hooks.example.com/nest-batch',
        'https://ops.example.com/ingest/nest-batch',
      ],
    }),
  ],
})
export class AppModule {}
```

`WebhookBatchModule.forRoot({...})` accepts:

| Field        | Type            | Required | Default                                   | Notes                                                                 |
| ------------ | --------------- | -------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `secret`     | `string`        | required (or via env) | —                                         | Host-injected HMAC-SHA256 secret. 32+ bytes of randomness recommended. |
| `urls`       | `string[]`      | yes      | —                                         | One or more absolute URLs the observer fans out to on every event.    |
| `events`     | `BatchEventType[]` | no    | `[JOB_COMPLETED, JOB_FAILED, STEP_FAILED]` | Subscription filter. Events not in the set are dropped silently.      |
| `attempts`   | `number`        | no       | `4`                                       | Total POST attempts. Clamped to `[1, 4]`. `1` = no retries.            |
| `timeoutMs`  | `number`        | no       | `10_000`                                  | Per-attempt HTTP timeout in ms. A timeout is treated as a network error. |
| `logger`     | `WebhookLogger` | no       | `new Logger('WebhookBatchObserver')`      | Nest-`Logger`-compatible surface for the dead-letter `warn` line.     |

`WebhookBatchModule` is registered as `global: true` (matching
`NestBatchModule` and the transport adapters) so consumers do
not need to re-import it in every sub-module. The observer is
auto-registered against the `BatchObserver` token, so the
executor / runtime services pick it up via the
`@Optional() observer: BatchObserver = new NoopBatchObserver()`
injection path without any extra wiring.

---

## Events

The v1 subscription default is three events. A `BatchEvent`
whose `type` is not in the set is dropped silently — the
observer never holds the executor back.

| Event                              | Constant                       | When it fires                                |
| ---------------------------------- | ------------------------------ | -------------------------------------------- |
| `nest-batch.job.completed`         | `BATCH_EVENT.JOB_COMPLETED`    | A `JobExecution` reached the `COMPLETED` terminal state. |
| `nest-batch.job.failed`            | `BATCH_EVENT.JOB_FAILED`       | A `JobExecution` reached the `FAILED` terminal state. |
| `nest-batch.step.failed`           | `BATCH_EVENT.STEP_FAILED`      | A `StepExecution` reached the `FAILED` terminal state. |

Override the default via the `events` option:

```ts
WebhookBatchModule.forRoot({
  secret: process.env.WEBHOOK_HMAC_SECRET,
  urls: ['https://hooks.example.com/nest-batch'],
  events: [BATCH_EVENT.JOB_COMPLETED, BATCH_EVENT.JOB_FAILED],
});
```

A future v2 may widen the default to include `STEP_*` /
`CHUNK_*` / `ITEM_*` events; in v1 only the three
terminal-state events trigger a POST.

---

## Retry policy

The fixed backoff schedule is `[1s, 5s, 25s, 125s]` — four
attempts total (one initial POST plus three retries). The
schedule is the v1 contract; the test suite
([`tests/webhook-observer.test.ts`](./tests/webhook-observer.test.ts),
T-AC-5) asserts against it.

| Outcome         | Behavior                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| `2xx`           | Success. The observer marks the delivery done.                                          |
| `3xx`           | Treated as a redirect. The observer follows the redirect once; if the redirect target returns 4xx / 5xx, that target's status drives the retry decision. |
| `4xx`           | **No retry.** Logged at `warn` level with the URL and the response body. The host is expected to fix the misconfiguration (bad URL, missing auth, malformed payload). |
| `5xx`           | **Retried** through the full 4-attempt budget at the 1s / 5s / 25s / 125s schedule. After the final attempt, dead-letter. |
| Network error   | **Retried** through the full 4-attempt budget. After the final attempt, dead-letter.    |
| Timeout         | Treated as a network error. **Retried** through the full 4-attempt budget.              |

### Fast-mode test override

The retry schedule can be overridden to `[1ms, 5ms, 25ms, 125ms]`
by setting the `WEBHOOK_TEST_FAST=1` env var. The override lets
the test suite exercise the 4-attempt retry path in <200ms
instead of the 156-second production schedule. The override is
gated behind an env var so production cannot trip it by
accident.

```bash
WEBHOOK_TEST_FAST=1 pnpm --filter @nest-batch/webhook test -- tests/webhook-observer.test.ts
```

### Dead-letter

After the final failed attempt (4xx not retried, or 5xx /
network / timeout after all 4 attempts), the observer emits:

```ts
logger.warn(
  `[WebhookBatchObserver] dead-letter url=${url} attempts=${attempts} ` +
    `lastStatus=${lastStatus ?? 'n/a'} lastError=${lastError} ` +
    `type=${event.type} jobExecutionId=${event.jobExecutionId} ` +
    `secret_sha256=${fingerprint}`,
);
```

The dead-letter is a log line, not a database row. The host
ships its log aggregator (Datadog, CloudWatch, Loki, ...)
to recover dead-lettered URLs. A future v2 may add a
`DeadLetterStore` token; v1 ships the log line only.

---

## HMAC signature

Every outbound POST carries a Stripe-style signature header:

```
X-Nest-Batch-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Where:

- `t=<unix>` is the unix-seconds timestamp the signature is
  pinned to. The receiver uses it to enforce a replay window
  (recommended: 5 minutes). The timestamp is also sent as a
  separate `X-Nest-Batch-Timestamp: <unix>` header for
  receivers that prefer parsing HTTP headers to parsing the
  signature header.
- `v1=<hex>` is the lowercase hex of
  `HMAC_SHA256(secret, "<unix>.<raw-body>")`.
- The `<raw-body>` is the EXACT JSON-serialized request body
  bytes (not a re-serialization). The receiver MUST HMAC the
  body it received, byte-for-byte; the observer does not
  re-serialize, so a different key order on the receiver
  side will fail verification.

### Receiver-side verification

The package exports `verifyV1` / `parseSignatureHeader` from
`@nest-batch/webhook` so a Node receiver can verify the
signature without re-implementing the crypto:

```ts
import {
  parseSignatureHeader,
  verifyV1,
  SIGNATURE_HEADER_NAME,
} from '@nest-batch/webhook';

app.post('/hook', (req, res) => {
  const header = String(req.headers[SIGNATURE_HEADER_NAME.toLowerCase()]);
  const raw = req.rawBody; // capture in your body parser
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!verifyV1(process.env.WEBHOOK_HMAC_SECRET, timestamp, raw, v1)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  // ... accept the envelope
  res.status(200).json({ ok: true });
});
```

Express users: mount `express.raw({ type: 'application/json' })`
on the webhook route so `req.body` is a `Buffer` (not the
default JSON-parsed object). The v1 signature is over the
**raw bytes**, not the parsed JSON. The example above
assumes the host mounted a raw-body parser that stashes the
bytes on `req.rawBody`.

### Why v1?

The `v1` key is the signature-scheme version, not the
envelope version. A future v2 may add `v2=`-prefixed schemes
(e.g. a SHA-512 variant or a multi-rotation scheme);
receivers MUST reject unknown `vN` keys. The v1 contract is
HMAC-SHA256 over `<unix>.<raw-body>`, lowercase hex, single
field.

---

## Secret handling

The HMAC secret is the single most sensitive value the package
handles. The contract:

- **Host-injection is primary.** Pass `secret` to `forRoot({...})`
  at module-build time. The package binds it to the
  `WebhookBatchObserver` instance via `WEBHOOK_MODULE_OPTIONS`
  (a private `Symbol.for` token); it is not exported, not
  injectable, not reachable from any public API.
- **Env fallback is secondary.** If `secret` is omitted,
  `forRoot({...})` falls back to `process.env.WEBHOOK_HMAC_SECRET`.
  Env is the safety net for hosts that do not want to thread
  the secret through their config service explicitly. The
  host's `ConfigModule` should set the env var from the
  secret manager.
- **Neither is the secret on disk.** The package does not read
  a file, does not read a CLI arg, does not read a Vault path.
  The host owns the secret source.
- **The secret is never logged.** The dead-letter line emits a
  SHA-256 fingerprint (`secret_sha256=abc123...`, first 12 hex
  chars) so operators can correlate dead-letters across
  services without exposing the secret. The full secret value
  is never written to a `logger` call, never serialized into a
  dead-letter body, never returned by any public API, never
  echoed in a stack trace.

The pinned acceptance test (T-AC-5) asserts no
`WEBHOOK_HMAC_SECRET` substring (or, equivalently, the
`secret` value the test injected) appears in the captured log
stream across the full 4-attempt retry budget, the 4xx
dead-letter path, the 5xx dead-letter path, the success path,
and the debug path.

---

## Launcher-only deployment — events do NOT fire without a worker

`@nest-batch/webhook` is a `BatchObserver` — it consumes the
event stream the executor / runtime services produce. The
event stream only fires when the host has wired a transport
**with** a running consumer:

- `BullmqAdapter.forRoot({ autoStartWorker: true })` — events
  fire (the worker drives the lifecycle and the
  `QueueEvents` bridge fans them out).
- `BullmqAdapter.forRoot({ autoStartWorker: false })` — **no
  events fire.** The launcher enqueues; no worker consumes;
  the lifecycle never reaches `COMPLETED` / `FAILED`; the
  observer never sees anything.
- `InProcessAdapter.forRoot()` — events fire (the strategy
  runs the lifecycle in-process).
- `KafkaAdapter.forRoot({ autoStartConsumer: true })` — events
  fire (the consumer drives the lifecycle and the consumer
  bridge fans them out).
- `KafkaAdapter.forRoot({ autoStartConsumer: false })` — **no
  events fire.** Same reason as the BullMQ launcher-only case.

This is the v1 contract. A launcher-only deployment (an API
service that only enqueues) does NOT need to install
`@nest-batch/webhook` — the observer would be dead code.

---

## What is NOT in this package

- A persistence adapter. Use `@nest-batch/mikro-orm`,
  `@nest-batch/typeorm`, `@nest-batch/drizzle`, or
  `@nest-batch/prisma` to wire a `JobRepository`. The observer
  is event-stream-only; it does not read or write any
  `JobExecution` rows.
- A batch engine. Job / Step / Chunk / Tasklet semantics,
  checkpoint, restart, skip, business retry, and the event
  stream itself live in
  [`@nest-batch/core`](../core). The observer is the
  downstream consumer.
- A transport. Use `@nest-batch/bullmq` or
  `@nest-batch/kafka` to drive the lifecycle. The observer
  does not enqueue or consume.
- A retry-policy module. The fixed `[1s, 5s, 25s, 125s]`
  backoff is the v1 contract. A future v2 may add a
  `retryDelaysMs` override; v1 ships the fixed schedule only.
- A dead-letter database. The dead-letter is a `logger.warn`
  line; a future v2 may add a `DeadLetterStore` token.
- A scheduler. Cron-style scheduling lives in
  `@nest-batch/core`'s `@BatchScheduled` decorator. The
  observer does not fire on a timer; it fires on the
  executor's event stream.
- An admin UI, metrics backend, or tracing backend. Hook a
  different `BatchObserver` (or extend this one) to ship
  events where you need them.
- Alternative HTTP transports (e.g. webhook-over-mqtt, gRPC
  webhooks). The observer uses HTTP POST + HMAC-SHA256. A
  future sibling package could ship a webhook-over-mqtt
  observer that implements the same `BatchObserver`
  contract.

---

## Scripts

```bash
pnpm --filter @nest-batch/webhook build      # SWC transpile + tsc declarations
pnpm --filter @nest-batch/webhook test       # vitest run (T-AC-5; see env note below)
pnpm --filter @nest-batch/webhook test:watch # vitest watch
pnpm --filter @nest-batch/webhook typecheck  # tsc --noEmit
```

The T-AC-5 test
([`tests/webhook-observer.test.ts`](./tests/webhook-observer.test.ts))
uses `WEBHOOK_TEST_FAST=1` to override the retry schedule to
milliseconds. Run it with:

```bash
WEBHOOK_TEST_FAST=1 pnpm --filter @nest-batch/webhook test -- tests/webhook-observer.test.ts --reporter=verbose
```

The full `pnpm test` run uses the same env var (set at the
top of the test file) so the suite finishes in <1s. The test
stands up a real `http.createServer().listen(0)` server on a
random port; no external service (Redis, Postgres) is
required.
