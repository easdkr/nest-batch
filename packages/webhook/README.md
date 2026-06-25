# @nest-batch/webhook

Webhook observer for `@nest-batch/core` lifecycle events. It sends
HMAC-SHA256-signed JSON envelopes to one or more URLs.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/webhook
```

Node 20 or newer is recommended because the package uses the runtime `fetch`
and `AbortController` APIs.

## Public Imports

```ts
import {
  WebhookBatchModule,
  WebhookBatchObserver,
  BATCH_EVENT,
  type WebhookBatchModuleOptions,
} from '@nest-batch/webhook';
```

## Wiring

```ts
import { WebhookBatchModule } from '@nest-batch/webhook';

@Module({
  imports: [
    NestBatchModule.forRoot({ adapters }),
    WebhookBatchModule.forRoot({
      secret: process.env.WEBHOOK_HMAC_SECRET,
      urls: ['https://hooks.example.com/nest-batch'],
      events: [BATCH_EVENT.JOB_COMPLETED, BATCH_EVENT.JOB_FAILED],
      timeoutMs: 10_000,
    }),
  ],
})
export class AppModule {}
```

The default subscription set is job completed, job failed, and step failed.
HTTP 4xx responses are treated as configuration failures and are not retried.
HTTP 5xx responses, network errors, and timeouts are retried with bounded
backoff.
