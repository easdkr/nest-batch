# 시작하기

이 문서는 Nest 애플리케이션에 `nest-batch` job을 붙이는 가장 짧은 경로를
설명합니다.

## 1. 패키지 설치

persistence adapter 하나와 transport adapter 하나를 선택합니다.

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm
```

로컬 실행은 `@nest-batch/core`에 포함된 `InProcessAdapter`만으로 충분합니다.

Redis 기반 worker가 필요하면 다음을 추가합니다.

```bash
pnpm add @nest-batch/bullmq bullmq ioredis
```

## 2. Batch metadata table 추가

`nest-batch`는 job instance, job execution, step execution, execution context를
애플리케이션 DB에 저장합니다. migration은 사용하는 애플리케이션이 소유합니다.

MikroORM에서는 exported metadata entity를 포함합니다.

```ts
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';

MikroOrmModule.forRoot({
  entities: [UserEntity, ...BATCH_META_ENTITIES],
  // your normal database options
});
```

그 다음 기존 애플리케이션 migration 도구로 migration을 생성하고 실행합니다.

## 3. `NestBatchModule` 연결

```ts
import { Module } from '@nestjs/common';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { MikroOrmAdapter } from '@nest-batch/mikro-orm';

@Module({
  imports: [
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

## 4. Job 정의

```ts
import { Injectable } from '@nestjs/common';
import { Batch } from '@nest-batch/core';

@Injectable()
@Batch.Jobable({ id: 'nightly-report', restartable: true })
export class NightlyReportJob {
  @Batch.Stepable({ id: 'build-report' })
  @Batch.Tasklet()
  async buildReport(): Promise<{ rows: number }> {
    return { rows: await buildReportRows() };
  }
}
```

`NightlyReportJob`을 module `providers`에 등록합니다.

## 5. 실행

```ts
import { JobLauncher } from '@nest-batch/core';

await jobLauncher.launch('nightly-report', {
  businessDate: '2026-06-25',
});
```

반환값은 durable job execution snapshot입니다. BullMQ 같은 비동기 transport를
사용하면 최초 응답은 queued 상태일 수 있습니다. 최종 상태는 `JobExplorer`나
애플리케이션 endpoint에서 조회하세요.

## 6. Demo 실행

저장소에는 `apps/demo` consumer app이 포함되어 있습니다.

```bash
pnpm install --frozen-lockfile
pnpm build
docker compose up -d
pnpm --filter @nest-batch/demo migration:up
pnpm --filter @nest-batch/demo start
```

demo import job 실행:

```bash
curl -X POST http://localhost:3000/jobs/import-products \
  -H 'content-type: application/json' \
  -d '{"file":"sample-data/products-valid.csv"}'
```
