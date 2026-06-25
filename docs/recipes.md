# Recipes

## Local In-Process Worker

Use this shape for tests, local scripts, and small jobs that can run in the
launcher process.

```ts
NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

## BullMQ Launcher and Worker

The launcher can enqueue work while a separate worker process consumes it.

```ts
BullmqAdapter.forRoot({
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  autoStartWorker: process.env.BATCH_WORKER === '1',
});
```

Run the same Nest app image in two roles:

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

Use a runtime adapter that knows how to bridge schedules into launches, or add
`@nest-batch/aws-eventbridge-scheduler` to mirror schedules into AWS.

## Webhook Notifications

```ts
import { WebhookBatchModule } from '@nest-batch/webhook';

WebhookBatchModule.forRoot({
  secret: process.env.WEBHOOK_HMAC_SECRET,
  urls: ['https://hooks.example.com/nest-batch'],
});
```

The webhook observer signs each payload with HMAC-SHA256. Receiver-side helpers
are exported from `@nest-batch/webhook`.

## Admin Endpoints

```ts
import { BatchAdminModule } from '@nest-batch/admin';

@Module({
  imports: [NestBatchModule.forRoot({ adapters }), BatchAdminModule],
})
export class AppModule {}
```

The controller is mounted under `/batch`.

## External Task Runtime

Use ECS, AWS Batch, or Kubernetes when each job execution should start a fresh
worker task.

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

The adapter passes `NEST_BATCH_JOB_ID`, `NEST_BATCH_JOB_EXECUTION_ID`, and worker
arguments to the external task. Your task image should boot the same Nest
application code and run the selected job execution.
