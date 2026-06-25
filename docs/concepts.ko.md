# 개념

`nest-batch`는 Spring Batch의 모델을 NestJS DI에 맞게 옮긴 패키지입니다.

## Job

job은 이름이 있는 작업 단위입니다. `@Batch.Jobable` 또는 `@nest-batch/core`의
builder API로 선언합니다.

```ts
@Batch.Jobable({ id: 'import-users', restartable: true })
export class ImportUsersJob {}
```

job id는 `JobLauncher.launch(jobId, params)`에서 사용하는 공개 이름입니다.

## Step

job은 하나 이상의 step으로 구성됩니다. step은 두 종류입니다.

- tasklet step: async method 하나가 한 번 실행됩니다.
- chunk step: item을 읽고, 처리하고, chunk 단위로 씁니다.

## Tasklet Step

item-level chunking이 필요 없는 작업에는 tasklet을 사용합니다.

```ts
@Batch.Stepable({ id: 'prepare-report' })
@Batch.Tasklet()
async prepareReport() {
  await createReportSnapshot();
}
```

## Chunk Step

많은 item을 읽어 batch로 써야 하면 chunk step을 사용합니다.

```ts
@Batch.Stepable({ id: 'sync-users', chunkSize: 500 })
syncUsers(): void {}

@Batch.ItemReader()
read() {}

@Batch.ItemProcessor()
process(item: UserRow) {}

@Batch.ItemWriter()
write(items: User[]) {}
```

chunk가 transaction boundary입니다. write가 실패하면 완료된 chunk를 다시 실행하지
않고 현재 chunk만 rollback할 수 있습니다.

## Job Parameters

parameters는 job 실행 요청을 식별합니다.

```ts
await launcher.launch('sync-users', {
  tenantId: 'acme',
  businessDate: '2026-06-25',
});
```

재시도와 재시작이 올바른 execution state를 찾을 수 있도록 안정적인 business key를
parameters에 넣으세요.

## Persistence

database는 durable batch state가 저장되는 곳입니다. persistence adapter는
`JobRepository`와 `TransactionManager`를 ORM 또는 DB client에 바인딩합니다.

migration ownership은 애플리케이션에 남아 있습니다. metadata entity/schema/model을
애플리케이션에 추가하고 기존 migration flow로 migration을 생성하세요.

## Transport

transport adapter는 실행 위치를 결정합니다.

- `InProcessAdapter`: launcher 프로세스 안에서 실행
- `BullmqAdapter`: Redis/BullMQ에 enqueue
- `KafkaAdapter`: Kafka에 enqueue
- AWS/Kubernetes adapter: 외부 worker task 시작

chunk 처리 같은 business semantics는 `@nest-batch/core`에 남고, transport adapter는
프로세스 사이로 작업을 이동시킵니다.

## Scheduling

`@BatchScheduled`는 job method에 schedule metadata를 기록합니다.

```ts
@BatchScheduled('0 * * * *', {
  name: 'hourly-import',
  timezone: 'UTC',
  overlap: 'skip',
})
scheduledImport(): void {}
```

runtime adapter가 schedule fire 방식을 결정합니다. BullMQ/Kafka는 schedule fire를
launch로 연결할 수 있고, EventBridge Scheduler는 schedule을 AWS 리소스로 반영할 수
있습니다.

## Observability

instrumentation에는 listener와 observer를 사용합니다.

- listener decorator는 job, step, chunk, read, process, write, skip 이벤트 전후에
  실행됩니다.
- `@nest-batch/webhook`은 lifecycle event envelope을 서명해서 외부 시스템으로
  전송합니다.
- `JobExplorer`와 `JobOperator`는 애플리케이션 endpoint나 admin tool에서 사용할 수
  있는 조회/제어 API를 제공합니다.
