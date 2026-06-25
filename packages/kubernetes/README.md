# @nest-batch/kubernetes

Kubernetes Job one-off execution adapter for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/kubernetes
```

Provide a client object with a `createJob(input)` method. It can wrap the
Kubernetes API client your application uses.

## Public Imports

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
