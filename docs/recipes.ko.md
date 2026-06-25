# 레시피

## 로컬 In-Process Worker

테스트, 로컬 script, launcher 프로세스 안에서 실행해도 되는 작은 job에 사용합니다.

```ts
NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

## BullMQ Launcher와 Worker

launcher는 작업을 enqueue하고, 별도 worker 프로세스가 consume할 수 있습니다.

```ts
BullmqAdapter.forRoot({
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  autoStartWorker: process.env.BATCH_WORKER === '1',
});
```

같은 Nest app image를 두 role로 실행합니다.

```bash
BATCH_WORKER=0 node dist/main.js
BATCH_WORKER=1 node dist/main.js
```

## Scheduled Job

```ts
@Batch.Jobable({ id: 'refresh-search-index' })
export class RefreshSearchIndexJob {
  @BatchScheduled('*/15 * * * *', {
    name: 'every-15-minutes',
    timezone: 'UTC',
    overlap: 'skip',
  })
  scheduled(): void {}
}
```

schedule fire를 launch로 연결할 수 있는 runtime adapter를 사용하거나,
`@nest-batch/aws-eventbridge-scheduler`를 추가해 AWS Scheduler 리소스로 반영합니다.

## Webhook 알림

```ts
import { WebhookBatchModule } from '@nest-batch/webhook';

WebhookBatchModule.forRoot({
  secret: process.env.WEBHOOK_HMAC_SECRET,
  urls: ['https://hooks.example.com/nest-batch'],
});
```

webhook observer는 각 payload를 HMAC-SHA256으로 서명합니다. receiver-side helper는
`@nest-batch/webhook`에서 export됩니다.

## Admin Endpoint

```ts
import { BatchAdminModule } from '@nest-batch/admin';

@Module({
  imports: [NestBatchModule.forRoot({ adapters }), BatchAdminModule],
})
export class AppModule {}
```

controller는 `/batch` 아래에 mount됩니다.

## External Task Runtime

job execution마다 새 worker task를 시작해야 하면 ECS, AWS Batch, Kubernetes adapter를
사용합니다.

```ts
EcsFargateAdapter.forRoot({
  client: ecsClient,
  cluster: process.env.ECS_CLUSTER_ARN,
  taskDefinition: process.env.ECS_TASK_DEFINITION_ARN,
  containerName: 'batch-worker',
  networkConfiguration: {
    subnets: process.env.ECS_SUBNETS.split(','),
    securityGroups: process.env.ECS_SECURITY_GROUPS.split(','),
  },
});
```

adapter는 `NEST_BATCH_JOB_ID`, `NEST_BATCH_JOB_EXECUTION_ID`, worker argument를
external task에 전달합니다. task image는 같은 Nest application code를 boot하고
선택된 job execution을 실행해야 합니다.
