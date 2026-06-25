# @nest-batch/webhook

`@nest-batch/core` lifecycle event를 외부 URL로 보내는 webhook observer입니다.
payload는 HMAC-SHA256으로 서명됩니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/webhook
```

패키지는 runtime `fetch`와 `AbortController` API를 사용하므로 Node 20 이상을
권장합니다.

## Public Import

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

기본 subscription은 job completed, job failed, step failed입니다. HTTP 4xx 응답은
설정 오류로 분류되고, HTTP 5xx, network error, timeout은 제한된 backoff로
retry됩니다.
