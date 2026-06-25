# nest-batch

`nest-batch`는 NestJS 애플리케이션에서 durable execution state,
restartable step, chunk-oriented processing, pluggable runtime adapter가 필요한
배치 작업을 구성하기 위한 패키지 모음입니다.

영문 문서는 [README.md](./README.md)를 보세요. 이 파일과 `docs/*.ko.md`는
같은 공개 인터페이스를 한국어로 설명합니다.

## 패키지는 역할별로 조합합니다

`nest-batch`는 런타임 책임을 기준으로 패키지가 나뉩니다. 실제 애플리케이션은 보통
필수 layer에서 하나씩 선택합니다.

| Layer              | 역할                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Core               | job class를 발견하고, step을 compile하고, chunk/tasklet을 실행하며 `JobLauncher`, `JobExplorer`, decorator, token을 제공합니다.     |
| Persistence 어댑터 | job instance, job execution, step execution, checkpoint, execution context 같은 durable metadata를 DB에 저장합니다.                 |
| Transport 어댑터   | 실행이 어디서 일어날지 결정합니다. 현재 프로세스, queue worker, SQS handoff, ECS task, AWS Batch job, Kubernetes Job 중 하나입니다. |
| Optional companion | schedule, webhook notification, admin route, deployment recipe 같은 부가 기능을 추가합니다.                                         |

persistence와 transport는 의도적으로 분리되어 있습니다. 예를 들어 상태 저장은
PostgreSQL/MikroORM으로 하면서 실행은 로컬 `InProcessAdapter`로 할 수도 있고, 같은
persistence 설정을 유지한 채 BullMQ worker로 넘길 수도 있습니다.

## 설치 조합 선택

로컬 개발 또는 단일 프로세스 worker:

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm
```

Redis 기반 분리 worker:

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm @nest-batch/bullmq bullmq ioredis
```

Drizzle + PostgreSQL 애플리케이션:

```bash
pnpm add @nest-batch/core @nest-batch/drizzle @nest-batch/postgresql drizzle-orm pg
```

## 패키지 맵

| Layer             | 패키지                                  | 실제 책임                                                                                        | 언제 추가하나요?                                                                              |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Core              | `@nest-batch/core`                      | Job/Step 모델, decorator, chunk/tasklet 실행, flow, launcher, explorer, operator, adapter token. | batch job을 정의하거나 실행하는 모든 애플리케이션.                                            |
| Persistence       | `@nest-batch/mikro-orm`                 | MikroORM 기반 `JobRepository`, `TransactionManager`, `BATCH_META_ENTITIES`.                      | 애플리케이션이 MikroORM을 쓰거나 batch metadata를 MikroORM으로 저장하려는 경우.               |
| Persistence       | `@nest-batch/typeorm`                   | TypeORM 기반 repository/transaction manager와 TypeORM batch meta entity.                         | TypeORM을 쓰고 migration도 TypeORM flow로 소유하려는 경우.                                    |
| Persistence slot  | `@nest-batch/drizzle`                   | Drizzle repository/transaction manager contract. DB별 schema는 DB driver package가 제공합니다.   | Drizzle을 쓸 때. `@nest-batch/postgresql` 또는 `@nest-batch/mysql`과 함께 사용합니다.         |
| Persistence slot  | `@nest-batch/prisma`                    | host-owned generated Prisma Client를 사용하는 Prisma repository/transaction manager contract.    | Prisma를 쓰고 `schema.prisma`에 batch meta model을 직접 포함할 때.                            |
| DB driver         | `@nest-batch/postgresql`                | ORM adapter slot을 위한 PostgreSQL shell과 Drizzle schema export.                                | persistence adapter가 PostgreSQL에서 동작하고 PostgreSQL-specific binding/schema가 필요할 때. |
| DB driver         | `@nest-batch/mysql`                     | ORM adapter slot을 위한 MySQL shell과 Drizzle schema export.                                     | persistence adapter가 MySQL에서 동작하고 MySQL-specific binding/schema가 필요할 때.           |
| Transport         | `@nest-batch/bullmq`                    | BullMQ execution strategy, Redis queue/worker runtime, schedule bridge.                          | launcher와 worker가 Redis/BullMQ로 통신할 때.                                                 |
| Transport         | `@nest-batch/kafka`                     | Kafka execution strategy, producer/consumer runtime, topic, consumer group wiring.               | launcher와 worker가 Kafka로 통신할 때.                                                        |
| Transport         | `@nest-batch/aws-sqs`                   | batch work message를 SQS로 보내는 execution strategy.                                            | launcher는 SQS에 넘기고 별도 runtime이 queue를 poll할 때.                                     |
| External compute  | `@nest-batch/aws-ecs`                   | job execution마다 ECS Fargate task를 시작하는 execution strategy.                                | 실행 단위를 one-off ECS task로 분리할 때.                                                     |
| External compute  | `@nest-batch/aws-batch`                 | AWS Batch job을 submit하는 execution strategy.                                                   | worker scheduling과 compute allocation을 AWS Batch에 맡길 때.                                 |
| External compute  | `@nest-batch/kubernetes`                | Kubernetes Job manifest를 생성하는 execution strategy.                                           | job execution마다 Kubernetes Job을 만들 때.                                                   |
| Scheduler         | `@nest-batch/aws-eventbridge-scheduler` | 발견된 `@BatchScheduled` metadata를 읽고 EventBridge Scheduler schedule을 생성합니다.            | schedule firing을 AWS가 소유해야 할 때.                                                       |
| Notification      | `@nest-batch/webhook`                   | batch event observer. lifecycle event envelope을 서명해서 POST합니다.                            | 외부 시스템이 job/step 완료 또는 실패 알림을 받아야 할 때.                                    |
| Admin             | `@nest-batch/admin`                     | `JobExplorer`, `JobOperator` 기반의 작은 Nest controller와 HTML renderer.                        | `/batch` 경로로 기본 조회/운영 endpoint가 필요할 때.                                          |
| Deployment helper | `@nest-batch/deployment`                | ECS, Kubernetes, AWS Batch, SQS/EventBridge 인프라 계획/generator용 plain typed recipe object.   | 문서, generator, internal platform tooling에 typed deployment metadata가 필요할 때.           |

## 최소 AppModule 구성

`NestBatchModule`에는 두 가지 어댑터가 필요합니다.

- `persistence`: durable execution state를 어디에 저장할지 결정합니다.
- `transport`: 실행을 어디서 수행하거나 어디로 넘길지 결정합니다.

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES, MikroOrmAdapter } from '@nest-batch/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [...BATCH_META_ENTITIES],
      driver: PostgreSqlDriver,
      dbName: process.env.DB_NAME,
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MikroOrmAdapter.forRoot(),
        transport: InProcessAdapter.forRoot(),
      },
    }),
  ],
})
export class AppModule {}
```

queue 기반 배포에서는 persistence adapter는 그대로 두고 transport만 교체합니다.

```ts
import { BullmqAdapter } from '@nest-batch/bullmq';

NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: BullmqAdapter.forRoot({
      connection: { host: process.env.REDIS_HOST, port: 6379 },
      autoStartWorker: process.env.BATCH_WORKER === '1',
    }),
  },
});
```

## 첫 Job 만들기

decorator는 `@nest-batch/core`의 `Batch` namespace 아래에서 import합니다.

```ts
import { Injectable } from '@nestjs/common';
import { Batch, type ItemExecutionContext } from '@nest-batch/core';

interface InputRow {
  id: string;
  email: string;
}

@Injectable()
@Batch.Jobable({ id: 'import-users', restartable: true })
export class ImportUsersJob {
  private rows: InputRow[] = [
    { id: '1', email: 'a@example.com' },
    { id: '2', email: 'b@example.com' },
  ];

  @Batch.Stepable({ id: 'load-users', chunkSize: 100 })
  loadUsers(): void {
    // Marker method. 실제 read/process/write는 아래 method들이 담당합니다.
  }

  @Batch.ItemReader()
  async read(_ctx?: ItemExecutionContext): Promise<InputRow | null> {
    return this.rows.shift() ?? null;
  }

  @Batch.ItemProcessor()
  async process(row: InputRow): Promise<InputRow> {
    return { ...row, email: row.email.toLowerCase() };
  }

  @Batch.ItemWriter()
  async write(items: InputRow[]): Promise<void> {
    await saveUsers(items);
  }
}
```

job class를 Nest provider로 등록하면 application bootstrap 시점에
`NestBatchModule`이 `@Batch.Jobable` provider를 찾아 job definition으로 등록합니다.

## Job 실행

애플리케이션에서 `JobLauncher`를 주입해 작업을 시작합니다.

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { JobLauncher, type JobParameters } from '@nest-batch/core';

@Controller('jobs')
export class JobsController {
  constructor(private readonly launcher: JobLauncher) {}

  @Post('import-users')
  launch(@Body() params: JobParameters) {
    return this.launcher.launch('import-users', params);
  }
}
```

`InProcessAdapter`는 현재 프로세스에서 바로 실행합니다. queue나 external task
adapter는 durable execution state를 기록한 뒤 선택한 runtime으로 작업을 넘깁니다.

## 문서

- [시작하기](./docs/getting-started.ko.md)
- [개념](./docs/concepts.ko.md)
- [어댑터](./docs/adapters.ko.md)
- [레시피](./docs/recipes.ko.md)
- [FAQ](./docs/faq.ko.md)

## 로컬 개발

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

demo app은 `apps/demo`에 있습니다.

```bash
docker compose up -d
pnpm --filter @nest-batch/demo migration:up
pnpm --filter @nest-batch/demo start
```

## License

MIT
