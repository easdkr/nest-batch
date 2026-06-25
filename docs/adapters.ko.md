# 어댑터

database와 queue 선택은 애플리케이션에 남아 있습니다. 동작하는 module
configuration에는 persistence adapter 하나와 transport adapter 하나가 필요합니다.

두 adapter slot은 서로 다른 질문에 답합니다.

| Slot          | 답하는 질문                              | 런타임 책임                                                                                              |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `persistence` | durable batch state를 어디에 저장하나요? | job instance, job execution, step execution, context를 위한 `JobRepository`와 `TransactionManager` 구현. |
| `transport`   | 실행이 실제로 어디서 일어나나요?         | 현재 프로세스에서 실행하거나, worker runtime에 enqueue하거나, 외부 compute task를 시작합니다.            |

두 선택은 독립적입니다. 같은 persistence adapter를 유지한 채 local execution에서
BullMQ, Kafka, SQS, ECS, AWS Batch, Kubernetes로 옮길 수 있고 job definition은 그대로
둘 수 있습니다.

```ts
NestBatchModule.forRoot({
  adapters: {
    persistence: MikroOrmAdapter.forRoot(),
    transport: InProcessAdapter.forRoot(),
  },
});
```

## Persistence Adapter

| Adapter  | Package                 | 패키지가 소유하는 것                                                             | host가 계속 소유하는 것                                              |
| -------- | ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| MikroORM | `@nest-batch/mikro-orm` | MikroORM 기반 `JobRepository`, `TransactionManager`, `BATCH_META_ENTITIES`.      | `MikroOrmModule.forRoot`, DB connection, migration.                  |
| TypeORM  | `@nest-batch/typeorm`   | TypeORM 기반 repository/transaction manager와 batch meta entity.                 | `TypeOrmModule.forRoot`, `DataSource`, DB connection, migration.     |
| Drizzle  | `@nest-batch/drizzle`   | Drizzle repository/transaction manager contract.                                 | `drizzle()` setup, connection pool, schema composition, migration.   |
| Prisma   | `@nest-batch/prisma`    | generated client를 대상으로 하는 Prisma repository/transaction manager contract. | `schema.prisma`, Prisma Client generation, DB connection, migration. |

persistence adapter는 core의 `JOB_REPOSITORY_TOKEN`과
`TRANSACTION_MANAGER_TOKEN`을 바인딩합니다. DB connection과 migration flow는
애플리케이션이 계속 소유합니다.

## Database Driver Package

`@nest-batch/postgresql`과 `@nest-batch/mysql`은 ORM slot을 위한 DB-specific shell을
제공합니다.

```ts
import { PostgresDrizzleAdapter, postgresDrizzleSchema } from '@nest-batch/postgresql';
import { MysqlDrizzleAdapter, mysqlDrizzleSchema } from '@nest-batch/mysql';
```

선택한 ORM adapter에 driver-specific table shape나 runtime binding이 필요할 때 이
패키지를 사용합니다.

## Transport Adapter

| Adapter     | Package                  | launch 시 실제로 일어나는 일                                                      |
| ----------- | ------------------------ | --------------------------------------------------------------------------------- |
| In-process  | `@nest-batch/core`       | 현재 Nest process가 job을 즉시 실행합니다.                                        |
| BullMQ      | `@nest-batch/bullmq`     | launcher가 Redis에 enqueue하고 BullMQ worker가 batch runtime을 실행합니다.        |
| Kafka       | `@nest-batch/kafka`      | launcher가 Kafka message를 produce하고 consumer가 batch runtime을 실행합니다.     |
| SQS         | `@nest-batch/aws-sqs`    | launcher가 SQS message를 보내고, 애플리케이션의 worker runtime이 받아 실행합니다. |
| ECS Fargate | `@nest-batch/aws-ecs`    | launcher가 job execution argument와 함께 ECS Fargate task를 시작합니다.           |
| AWS Batch   | `@nest-batch/aws-batch`  | launcher가 job execution argument와 함께 AWS Batch job을 submit합니다.            |
| Kubernetes  | `@nest-batch/kubernetes` | launcher가 job execution을 위한 Kubernetes Job manifest를 생성합니다.             |

transport adapter는 core execution strategy를 바인딩합니다. job definition은 core에
남고, durable state는 선택한 persistence adapter 뒤에 남습니다.

## Scheduler와 Observer

`@nest-batch/aws-eventbridge-scheduler`는 발견된 `@BatchScheduled` entry를 읽어 AWS
EventBridge Scheduler 리소스를 생성합니다.

`@nest-batch/webhook`은 batch lifecycle event를 구독하고 설정한 URL로 서명된 JSON
payload를 전송합니다.

이 패키지들은 선택적인 companion입니다. 기본 `NestBatchModule` wiring 옆에 함께
추가합니다.

## Admin과 Deployment Helper

`@nest-batch/admin`은 job 조회와 operation을 위한 작은 HTTP controller와 HTML
renderer를 제공합니다.

`@nest-batch/deployment`는 runtime infrastructure를 문서화하거나 생성하는 데 쓸 수
있는 typed recipe helper를 export합니다.
