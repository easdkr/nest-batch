import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { BATCH_EVENT, type BatchEventType } from '@nest-batch/core';

import {
  resolveWebhookOptions,
  WEBHOOK_MODULE_OPTIONS,
  type ResolvedWebhookOptions,
  type WebhookBatchModuleOptions,
  type WebhookLogger,
} from './module-options';
import { WebhookBatchObserver } from './webhook-batch.observer';

/**
 * `WebhookBatchModule` — the NestJS dynamic module that wires
 * the `WebhookBatchObserver` into the host's DI container and
 * binds it to the `BatchObserver` token used by the executor
 * (and by `@nest-batch/bullmq` / `@nest-batch/kafka`'s runtime
 * bridge).
 *
 * The host wires it alongside `NestBatchModule.forRoot({...})`:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     NestBatchModule.forRoot({
 *       adapters: { persistence: MikroOrmAdapter.forRoot(), transport: BullmqAdapter.forRoot() },
 *     }),
 *     WebhookBatchModule.forRoot({
 *       secret: process.env.WEBHOOK_HMAC_SECRET,
 *       urls: ['https://hooks.example.com/nest-batch'],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The observer is auto-registered against the `BatchObserver`
 * token via `useExisting`, so the executor's optional-injection
 * path picks it up without any extra wiring on the host's side.
 */
@Module({})
export class WebhookBatchModule {}

/**
 * `forRoot` — synchronous configuration. Resolves the options
 * up-front (filling in defaults, falling back to the
 * `WEBHOOK_HMAC_SECRET` env var when `secret` is omitted,
 * freezing the result) and emits a `DynamicModule` that:
 *
 *   - registers `WebhookBatchObserver` as a provider,
 *   - registers a `useExisting` alias so anything injecting
 *     `BatchObserver` (or `WebhookBatchObserver` by class)
 *     resolves to the same instance,
 *   - registers the resolved options under
 *     `WEBHOOK_MODULE_OPTIONS` (the observer's `@Inject`
 *     key),
 *   - marks the module `global: true` so the observer is
 *     visible across the host's sub-modules.
 *
 * The `urls: []` case is a no-op (the observer subscribes
 * to the event stream but never POSTs); it does not throw.
 * The `secret` case throws at `forRoot` time with a clear
 * message (the host sees the error at boot, not at the first
 * event).
 */
export function forRoot(options: WebhookBatchModuleOptions): DynamicModule {
  const resolved = resolveWebhookOptions(options);
  return {
    module: WebhookBatchModule,
    global: true,
    providers: buildProviders(resolved),
    exports: [WebhookBatchObserver],
  };
}

/**
 * Build the static provider list shared by `forRoot()`.
 *
 * The list is three entries:
 *   - `WebhookBatchObserver` — the concrete class.
 *   - `BATCH_OBSERVER_PROVIDER` — a `useExisting` alias so the
 *     executor's `@Optional() @Inject(BatchObserver) observer`
 *     resolves to the same instance.
 *   - `WEBHOOK_MODULE_OPTIONS` — the resolved + frozen
 *     options bag, injected into the observer's constructor.
 *
 * Centralising the list keeps the public factory surface
 * (`forRoot`) a one-liner; any future addition (e.g. a
 * per-package health check) only needs to land here.
 */
function buildProviders(resolved: ResolvedWebhookOptions): Provider[] {
  return [
    WebhookBatchObserver,
    {
      provide: BATCH_OBSERVER_TOKEN,
      useExisting: WebhookBatchObserver,
    },
    {
      provide: WEBHOOK_MODULE_OPTIONS,
      useValue: resolved,
    },
  ];
}

/**
 * The DI token the executor / runtime services use to inject
 * a `BatchObserver`. We re-export the `BatchObserver` class
 * itself as the token (mirroring the pattern in
 * `@nest-batch/bullmq` and `@nest-batch/kafka`, where the
 * `BatchObserver` interface is the type and the class-as-
 * token resolves to the singleton).
 *
 * Using the `BatchObserver` class (an interface in
 * `@nest-batch/core`) as the token is a NestJS pattern:
 * Nest uses the class reference as the default DI key. We
 * redeclare it as `BATCH_OBSERVER_TOKEN` so the `useExisting`
 * provider above has a stable, imported symbol to bind
 * against.
 */
const BATCH_OBSERVER_TOKEN: symbol = Symbol.for(
  '@nest-batch/webhook/BATCH_OBSERVER',
);

// Re-export the public surface of this module so the
// package barrel can re-export it in turn.
export {
  BATCH_EVENT,
  WebhookBatchObserver,
  type BatchEventType,
  type ResolvedWebhookOptions,
  type WebhookBatchModuleOptions,
  type WebhookLogger,
};
