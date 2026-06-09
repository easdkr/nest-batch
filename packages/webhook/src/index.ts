/**
 * Public API barrel for `@nest-batch/webhook`.
 *
 * Hosts import the factory (`forRoot`) and the observer class
 * (`WebhookBatchObserver`) from this barrel; everything else
 * is an implementation detail. The barrel re-exports:
 *
 *   - `forRoot` — the synchronous `DynamicModule` factory. The
 *     host calls `WebhookBatchModule.forRoot({...})` (the
 *     `WebhookBatchModule` is re-exported alongside so the
 *     type is reachable from this entry point).
 *   - `WebhookBatchObserver` — the concrete class. Useful for
 *     type-strict consumers that prefer class injection.
 *   - `BATCH_EVENT` — the `BATCH_EVENT` constants from
 *     `@nest-batch/core`, re-exported so a host that wants to
 *     filter subscriptions does not have to add
 *     `@nest-batch/core` as a direct dep.
 *   - `signV1` / `buildSignatureHeader` / `parseSignatureHeader`
 *     / `verifyV1` / `fingerprintSecret` — the HMAC signing
 *     helpers, useful for hosts that want to write their own
 *     webhook receiver against the same contract.
 *   - The TypeScript types: `WebhookBatchModuleOptions`,
 *     `ResolvedWebhookOptions`, `WebhookLogger`,
 *     `WebhookEnvelope`.
 */
export { forRoot, WebhookBatchModule, WebhookBatchObserver } from './webhook-batch.module';
export { BATCH_EVENT } from '@nest-batch/core';
export type {
  BatchEvent,
  BatchEventType,
  BatchObserver,
} from '@nest-batch/core';
export {
  signV1,
  buildSignatureHeader,
  parseSignatureHeader,
  verifyV1,
  fingerprintSecret,
  SIGNATURE_HEADER_NAME,
} from './webhook-signing';
export type { WebhookEnvelope } from './webhook-batch.observer';
export type {
  ResolvedWebhookOptions,
  WebhookBatchModuleOptions,
  WebhookLogger,
} from './module-options';
