# @nest-batch/admin

Small Nest-native admin HTTP surface for `@nest-batch/core`.

Korean: [README.ko.md](./README.ko.md)

## Install

```bash
pnpm add @nest-batch/core @nest-batch/admin
```

## Public Imports

```ts
import { BatchAdminController, BatchAdminModule, renderBatchAdminHtml } from '@nest-batch/admin';
```

## Wiring

```ts
import { BatchAdminModule } from '@nest-batch/admin';

@Module({
  imports: [NestBatchModule.forRoot({ adapters }), BatchAdminModule],
})
export class AppModule {}
```

The controller is mounted under `/batch` and exposes job/execution inspection
and basic operations.

## Routes

| Route                                         | Purpose                               |
| --------------------------------------------- | ------------------------------------- |
| `GET /batch`                                  | HTML dashboard.                       |
| `GET /batch/jobs`                             | List discovered jobs.                 |
| `GET /batch/jobs/:jobName/instances`          | List instances for a job.             |
| `GET /batch/executions`                       | List executions, optionally filtered. |
| `GET /batch/executions/:executionId`          | Read execution details.               |
| `POST /batch/executions/:executionId/stop`    | Stop an execution.                    |
| `POST /batch/executions/:executionId/restart` | Restart an execution.                 |
| `POST /batch/executions/:executionId/abandon` | Mark an execution abandoned.          |
| `POST /batch/jobs/:jobId/start-next`          | Start the next instance.              |
