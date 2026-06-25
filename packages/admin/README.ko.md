# @nest-batch/admin

`@nest-batch/core`를 위한 작은 Nest-native admin HTTP surface입니다.

English: [README.md](./README.md)

## 설치

```bash
pnpm add @nest-batch/core @nest-batch/admin
```

## Public Import

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

controller는 `/batch` 아래에 mount되며 job/execution 조회와 기본 operation을
제공합니다.

## Routes

| Route                                         | 용도                    |
| --------------------------------------------- | ----------------------- |
| `GET /batch`                                  | HTML dashboard.         |
| `GET /batch/jobs`                             | 발견된 job 목록.        |
| `GET /batch/jobs/:jobName/instances`          | job instance 목록.      |
| `GET /batch/executions`                       | execution 목록.         |
| `GET /batch/executions/:executionId`          | execution detail.       |
| `POST /batch/executions/:executionId/stop`    | execution stop.         |
| `POST /batch/executions/:executionId/restart` | execution restart.      |
| `POST /batch/executions/:executionId/abandon` | execution abandon 처리. |
| `POST /batch/jobs/:jobId/start-next`          | 다음 instance 시작.     |
