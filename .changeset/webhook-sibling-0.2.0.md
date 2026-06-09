---
'@nest-batch/webhook': minor
---

New sibling package `@nest-batch/webhook`. The package ships a
`WebhookBatchObserver` that subscribes to the `BATCH_EVENT.*`
lifecycle stream and POSTs an HMAC-SHA256-signed JSON envelope
to one or more URLs, with exponential-backoff retry on 5xx /
network errors, a `logger.warn` dead-letter on final failure,
and a hard `no retry on 4xx` rule.

## Highlights

- **Module factory.** `WebhookBatchModule.forRoot({ secret,
  urls, events?, attempts?, timeoutMs?, logger? })` returns a
  `global: true` NestJS `DynamicModule` that wires the
  observer into the host's DI container. The host may also
  pass nothing for `secret` and rely on the
  `WEBHOOK_HMAC_SECRET` env var as a fallback (env is the
  safety net, host-injection is primary).
- **Stripe-style signature header.** Every outbound POST
  carries `X-Nest-Batch-Signature: t=<unix>,v1=<hex-hmac-sha256>`,
  where `<hex>` is `HMAC_SHA256(secret, "<unix>.<raw-body>")`.
  The package exports `signV1` / `parseSignatureHeader` /
  `verifyV1` / `fingerprintSecret` so a Node receiver can
  verify the signature without re-implementing the crypto.
- **Fixed retry schedule.** `[1s, 5s, 25s, 125s]` (4 attempts
  total) on 5xx and network errors. HTTP 4xx responses are
  NOT retried (client error, won't change). A timeout is
  treated as a network error. The `WEBHOOK_TEST_FAST=1` env
  var overrides the schedule to `[1ms, 5ms, 25ms, 125ms]`
  for fast tests; production cannot trip the override
  without the env var.
- **Dead-letter.** After the final failed attempt, the
  observer emits a `logger.warn` line with the URL, attempt
  count, last status / error, event type, `jobExecutionId`,
  and a SHA-256 fingerprint of the secret. The full secret
  is NEVER logged in any code path (asserted by T-AC-5).
- **Native `fetch`.** Uses Node 20+ built-in `fetch` +
  `AbortController` for the per-attempt timeout. No HTTP
  client library is added as a peer dep.
- **Transport-agnostic.** The observer consumes the
  `BatchObserver.onEvent` contract from `@nest-batch/core`.
  BullMQ, Kafka, and the in-process strategy all bridge to
  it without any extra wiring on the host's side.
- **Pinned acceptance test.** T-AC-5 in
  `packages/webhook/tests/webhook-observer.test.ts` stands
  up a real `http.createServer().listen(0)` server on a
  random port and asserts: HMAC byte-equality, retry on
  5xx, NO retry on 4xx, dead-letter `logger.warn` on final
  failure, secret NEVER logged, subscription filter, module
  factory shape, envelope shape, `stepId` propagation.

## Launcher-only deployment note

The observer consumes the `BATCH_EVENT.*` lifecycle stream
that the executor / runtime services produce. The stream
only fires when the host has wired a transport **with** a
running consumer. A launcher-only deployment (an API service
that only enqueues, with `autoStartWorker: false` /
`autoStartConsumer: false`) does NOT need to install this
package — the observer would be dead code. Documented in
the README's "Launcher-only deployment" section.

## Files added

- `packages/webhook/package.json` (3 peer deps: core,
  `@nestjs/common`, `@nestjs/core`; no HTTP client peer dep)
- `packages/webhook/tsconfig.json` + `tsconfig.build.json`
  (root-extending)
- `packages/webhook/vitest.config.ts` (root-extending)
- `packages/webhook/src/index.ts` (public API barrel)
- `packages/webhook/src/module-options.ts` (options bag +
  `resolveWebhookOptions` + `WEBHOOK_MODULE_OPTIONS` token)
- `packages/webhook/src/webhook-signing.ts`
  (`signV1` / `parseSignatureHeader` / `verifyV1` /
  `fingerprintSecret` / `SIGNATURE_HEADER_NAME`)
- `packages/webhook/src/webhook-batch.observer.ts`
  (`WebhookBatchObserver` class)
- `packages/webhook/src/webhook-batch.module.ts`
  (`forRoot` factory + `WebhookBatchModule` empty class)
- `packages/webhook/tests/webhook-observer.test.ts` (T-AC-5)
- `packages/webhook/README.md` (9 sections, ~250 lines)
