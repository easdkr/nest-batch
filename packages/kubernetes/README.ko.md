# @nest-batch/kubernetes

`@nest-batch/core`용 Kubernetes Job one-off execution adapter입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/kubernetes
```

`createJob(input)` method를 가진 client object를 제공하세요. 애플리케이션에서
사용하는 Kubernetes API client를 감싼 wrapper여도 됩니다.

## Public Import

```ts
import {
  KubernetesJobAdapter,
  KubernetesJobLauncher,
  type KubernetesJobModuleOptions,
} from '@nest-batch/kubernetes';
```

## Wiring

```ts
import { KubernetesJobAdapter } from '@nest-batch/kubernetes';

NestBatchModule.forRoot({
  adapters: {
    persistence: persistenceAdapter,
    transport: KubernetesJobAdapter.forRoot({
      client: kubernetesJobsClient,
      namespace: 'batch',
      image: 'registry.example.com/orders-worker:latest',
      containerName: 'batch-worker',
      command: ['node', 'dist/batch-worker.js'],
      serviceAccountName: 'batch-worker',
    }),
  },
});
```
