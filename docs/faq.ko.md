# FAQ

## `@nest-batch/core`에 database adapter가 포함되어 있나요?

아니요. core는 job semantics와 public contract를 담당합니다.
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/drizzle`,
`@nest-batch/prisma` 중 persistence adapter를 선택하세요.

## 패키지가 migration을 실행해 주나요?

아니요. consuming application이 migration을 소유합니다. exported metadata
entity/schema/model을 애플리케이션에 추가하고 기존 ORM 도구로 migration을
생성하세요.

## 어떤 transport부터 시작해야 하나요?

별도 worker fleet이 이미 필요한 상황이 아니라면 `InProcessAdapter`로 시작하세요.
queueing, isolation, external compute가 필요해지면 BullMQ, Kafka, SQS, ECS, AWS
Batch, Kubernetes로 옮기면 됩니다.

## 왜 `JobLauncher.launch`가 job 완료 전에 반환되나요?

queue와 external-task transport는 다른 runtime에 작업을 넘깁니다. 이런 배포에서는
launch 응답이 enqueue 또는 task submission 직후의 durable state를 반영합니다.
최종 상태는 `JobExplorer`나 애플리케이션 endpoint로 조회하세요.

## 한 Nest application에 여러 job을 정의할 수 있나요?

네. 각 `@Batch.Jobable` class를 provider로 등록하세요. `NestBatchModule`은 bootstrap
시점에 등록된 job provider를 모두 발견합니다.

## job을 schedule할 수 있나요?

네. job class의 marker method에 `@BatchScheduled`를 추가하세요. schedule을 launch로
연결하는 runtime adapter를 사용하거나, `@nest-batch/aws-eventbridge-scheduler`로 AWS
Scheduler entry를 생성할 수 있습니다.

## BullMQ가 item마다 BullMQ job을 만들나요?

아니요. BullMQ는 batch work를 전달하는 transport입니다. chunk read/process/write,
skip, retry, checkpoint 동작은 core에 남습니다.

## lifecycle event를 받을 수 있나요?

네. job class의 listener decorator로 local hook을 만들거나,
`@nest-batch/webhook`을 추가해 서명된 lifecycle event envelope을 외부 시스템으로
전송할 수 있습니다.

## admin UI가 있나요?

`@nest-batch/admin`은 `/batch` 아래에 작은 Nest controller와 HTML renderer를
제공합니다. 애플리케이션 인증/인가로 감싸서 사용하는 lightweight operational
surface입니다.
