# nest-batch Critical Bug Fixes — DoD #6 Unblock

## TL;DR

> **Quick Summary**: F3 Real Manual QA에서 3개의 CRITICAL bug가 발견되어 plan의 Definition of Done (DoD) #6가 충족되지 않았습니다. 이 plan은 그 3개 bug를 수정하고, 부수적인 4개 HIGH 시나리오도 함께 해결하여 포팅을 진짜로 완료합니다.
>
> **Deliverables**:
> - JobExecutor 성공 경로에서 `exitCode: 'COMPLETED'` 설정
> - `BullmqBatchModule`이 `JOB_REPOSITORY_TOKEN`을 export하여 DI 정상화
> - `ChunkStepExecutor` skip 시 writeCount 처리 또는 demo `ProductWriter`의 skip 정책 정합성
> - `library-integration.e2e.spec.ts` import 수정
> - `vitest.e2e.config.ts`에서 `bullmq-import-products.e2e.spec.ts` 제외
> - `mikro-orm` 동시 실행 직렬화 (FOR UPDATE SKIP LOCKED) 검증
>
> **Estimated Effort**: Small (5-7 tasks)
> **Parallel Execution**: YES — 3개 bug는 서로 다른 패키지에 있어 병렬 가능
> **Critical Path**: 버그 수정 → 통합 테스트 → F3 재검증

---

## Context

### Original Request
> "추가 작업 진행" (사용자가 F3 REJECT 후 추가 작업 요청)

### Prior State
- `nest-batch-architecture-enhancement` plan 완료 (24/28 implementation + 4/4 verification)
- F1: APPROVE, F2: CONDITIONAL_APPROVE, **F3: REJECT**, F4: APPROVE
- DoD #6 "Redis + DB e2e proves BullMQ transport writes canonical execution state" **미충족**

### F3가 발견한 Critical Bugs

| # | 파일 | 버그 |
|---|------|------|
| **1** | `packages/core/src/execution/job-executor.ts:306-311` | 성공 시 `exitCode: 'COMPLETED'` 미설정. 모든 COMPLETED 잡의 `exit_code`가 빈 문자열 |
| **2** | `packages/bullmq/src/bullmq-batch.module.ts` | `JOB_REPOSITORY_TOKEN` 미export. `BullmqRuntimeService` DI 실패. live demo `BATCH_TRANSPORT=bullmq` 부팅 불가 |
| **3** | `packages/core/src/execution/chunk-step-executor.ts` skip 경로 | `writeCount=0` 버그. skip 시나리오에서 write count 미누적 |
| **4** | `apps/demo/tests/e2e/library-integration.e2e.spec.ts:135` | `JobInstanceEntity` 참조하지만 import 누락 |
| **5** | `apps/demo/vitest.e2e.config.ts` | `bullmq-import-products.e2e.spec.ts` 잘못 포함 |
| **6** | `packages/mikro-orm` 동시 실행 | `createExecutionAtomic`이 FOR UPDATE SKIP LOCKED로 직렬화되지 않음 |
| **7** | `apps/demo/src/jobs/import-products/reader/csv-product.reader.ts` | reader iterator 메모이즈이션으로 2nd launch 실패 |
| **8** | `packages/bullmq/tests/bullmq-runtime.test.ts` "DB-first execution" | `#1`과 동일 (job-level exitCode 미설정) |

### Test Strategy Decision
- **Infrastructure exists**: YES (PostgreSQL :5434, Redis :6379 실행 중)
- **Automated tests**: TDD
- **Framework**: vitest
- **Agent-Executed QA**: 모든 task에 QA scenario 포함

---

## Work Objectives

### Core Objective
F3에서 발견된 3개 critical bug를 수정하여 DoD #6를 충족하고, 부수적 HIGH/SEVERE 이슈를 함께 해결하여 plan을 진짜로 완료한다.

### Concrete Deliverables
- ✅ `pnpm --filter @nest-batch/core test` — 532/532 pass
- ✅ `pnpm --filter @nest-batch/bullmq test` — 6/6 pass (DB-first execution 포함)
- ✅ `pnpm --filter @nest-batch/demo test:e2e` — 10/10 pass (skip 시나리오 포함)
- ✅ live demo `BATCH_TRANSPORT=bullmq` 부팅 + `exit_code='COMPLETED'` 검증
- ✅ live demo `batch_job_execution.exit_code`가 COMPLETED 잡에 대해 `'COMPLETED'`

### Must Have
- [ ] Bug #1 수정: JobExecutor 성공 경로에서 `exitCode: 'COMPLETED'` 설정
- [ ] Bug #2 수정: `BullmqBatchModule`이 `JOB_REPOSITORY_TOKEN`을 export 또는 re-provide
- [ ] Bug #3 수정: `ChunkStepExecutor` writeCount 처리 또는 demo `ProductWriter` 정합성
- [ ] Bug #4 수정: `library-integration.e2e.spec.ts` import 추가
- [ ] Bug #5 수정: `vitest.e2e.config.ts`에서 `bullmq-import-products.e2e.spec.ts` 제외
- [ ] F3 재검증: 모든 시나리오 통과

### Must NOT Have (Guardrails)
- ❌ 새 기능 추가 금지
- ❌ API 변경 금지
- ❌ 새 의존성 추가 금지
- ❌ 다른 검증 통과한 코드 변경 금지

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — 모든 검증은 agent-executed.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD
- **Framework**: vitest

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Critical Bug Fixes — all independent, can run in parallel):
├── Task 1: Fix #1 — JobExecutor success path sets exitCode='COMPLETED'
├── Task 2: Fix #2 — BullmqBatchModule exports JOB_REPOSITORY_TOKEN
├── Task 3: Fix #3 — ChunkStepExecutor writeCount on skip path (or ProductWriter consistency)
└── Task 4: Fix #4 + #5 — Demo e2e config + library-integration import

Wave 2 (Verification):
├── Task 5: Re-run F3 scenarios with all fixes applied
├── Task 6: Run full test suite + live demo + capture evidence
└── Task 7: Update plan checkboxes + commit + close

Critical Path: Tasks 1-4 (parallel) → Task 5 → Task 6 → Task 7
Parallel Speedup: ~60% vs sequential
Max Concurrent: 4 (Wave 1)
```

### Dependency Matrix
- **1**: blocks 5; blocked by none; wave 1.
- **2**: blocks 5; blocked by none; wave 1.
- **3**: blocks 5; blocked by none; wave 1.
- **4**: blocks 5; blocked by none; wave 1.
- **5**: blocks 6; blocked by 1-4; wave 2.
- **6**: blocks 7; blocked by 5; wave 2.
- **7**: blocked by 6; wave 2.

---

## TODOs

### Wave 1 — CRITICAL BUG FIXES

- [x] 1. Fix #1: JobExecutor sets `exitCode: 'COMPLETED'` on success path

  **What to do**:
  - `packages/core/src/execution/job-executor.ts:306-311` 수정
  - 성공 시 `updateJobExecution`에 `exitCode: 'COMPLETED'` 추가
  - 일관성을 위해 `exitMessage`도 빈 문자열 또는 `'OK'`로 명시
  - RED-GREEN: `packages/core/tests/execution/job-executor.test.ts`에 새 테스트 추가하여 검증

  **Root cause**:
  - FAILED 경로(line 286-291)는 `exitCode: result.exitCode`를 명시하지만
  - COMPLETED 경로(line 306-311)는 `exitCode`를 설정하지 않음 → DB의 default `''` 그대로

  **Must NOT do**: 다른 로직 변경 금지, StepStatus 결과 처리 변경 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: 2-line 수정, 명확한 root cause

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-4)
  - **Blocks**: 5 (F3 re-verification)
  - **Blocked By**: None

  **References**:
  - `packages/core/src/execution/job-executor.ts:306-311`
  - `packages/core/src/execution/job-executor.ts:286-291` (FAILED 경로 — 모델)
  - `packages/bullmq/tests/bullmq-runtime.test.ts:328` ("DB-first execution" 테스트)
  - `.omo/evidence/f3-real-qa.md` (line 18: 버그 #2 위치)

  **Acceptance Criteria**:
  - [ ] JobExecutor의 COMPLETED 분기에 `exitCode: 'COMPLETED'` 포함
  - [ ] `pnpm --filter @nest-batch/core test job-executor` 통과
  - [ ] `pnpm --filter @nest-batch/bullmq test bullmq-runtime`에서 "DB-first execution" 통과
  - [ ] LIVE DB에서 `batch_job_execution.exit_code`가 COMPLETED 잡에 대해 `'COMPLETED'`

  **QA Scenarios**:
  ```
  Scenario: JobExecutor sets exitCode on success
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/core test job-executor
    Expected: exit 0, new test passes
    Evidence: .omo/evidence/task-1-job-executor-exitcode.log

  Scenario: BullMQ DB-first execution passes
    Tool: Bash (vitest + Redis)
    Preconditions: Redis at 127.0.0.1:6379
    Steps:
      1. pnpm --filter @nest-batch/bullmq test bullmq-runtime
    Expected: exit 0, "DB-first execution" test passes
    Evidence: .omo/evidence/task-1-bullmq-db-first.log

  Scenario: Live demo COMPLETED job has exit_code='COMPLETED'
    Tool: Bash (psql + curl)
    Preconditions: PG :5434, demo app running with BATCH_TRANSPORT=in-process
    Steps:
      1. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
      2. PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
    Expected: status=COMPLETED, exit_code='COMPLETED'
    Evidence: .omo/evidence/task-1-live-exitcode.log
  ```

  **Commit**: YES
  - Message: `fix(core): set JobExecutor exitCode='COMPLETED' on success path`
  - Files: `packages/core/src/execution/job-executor.ts`, `packages/core/tests/execution/job-executor.test.ts`

- [x] 2. Fix #2: BullmqBatchModule exports JOB_REPOSITORY_TOKEN

  **What to do**:
  - `packages/bullmq/src/bullmq-batch.module.ts` 수정
  - `JOB_REPOSITORY_TOKEN`을 import (already from core)하고 `exports` 배열에 추가
  - 또는 `NestBatchModule`을 import하여 `JOB_REPOSITORY_TOKEN`이 자동으로 re-export되도록 함
  - **권장**: 옵션 B — `imports: [NestBatchModule]`을 추가하고 `global: true` 활용

  **Root cause**:
  - `BullmqBatchModule`이 `EXECUTION_STRATEGY`만 export
  - `JOB_REPOSITORY_TOKEN`은 `NestBatchModule`이 export하지만, BullmqBatchModule의 DI scope에 없음
  - `BullmqRuntimeService`의 `@Inject(JOB_REPOSITORY_TOKEN)`이 해석 불가

  **Must NOT do**:
  - 다른 모듈 변경 금지
  - DI 토큰을 string으로 변경 금지 (Symbol.for 유지)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: NestJS DI 구조 이해 필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: 5
  - **Blocked By**: None

  **References**:
  - `packages/bullmq/src/bullmq-batch.module.ts:95-102` (exports 배열)
  - `packages/bullmq/src/bullmq-runtime.service.ts:148-149` (JOB_REPOSITORY_TOKEN 사용)
  - `packages/core/src/module/nest-batch.module.ts` (NestBatchModule 정의)
  - `.omo/evidence/f3-real-qa.md` (line 17)

  **Acceptance Criteria**:
  - [ ] `BullmqBatchModule`이 `JOB_REPOSITORY_TOKEN` 해석 가능
  - [ ] live demo `BATCH_TRANSPORT=bullmq` 부팅 성공
  - [ ] `pnpm --filter @nest-batch/demo test:e2e`의 `bullmq-import-products.e2e.spec.ts`가 더 이상 DI 에러로 죽지 않음

  **QA Scenarios**:
  ```
  Scenario: BullmqBatchModule wiring fix verified
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/bullmq test
    Expected: exit 0, all tests pass
    Evidence: .omo/evidence/task-2-bullmq-tests.log

  Scenario: Live demo boots in bullmq mode
    Tool: Bash (curl)
    Preconditions: PG :5434, Redis :6379
    Steps:
      1. BATCH_TRANSPORT=bullmq pnpm --filter @nest-batch/demo start:dev &
      2. sleep 8
      3. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
    Expected: 200, no "UnknownDependenciesException", executionId returned
    Evidence: .omo/evidence/task-2-live-bullmq-boot.log
  ```

  **Commit**: YES
  - Message: `fix(bullmq): export JOB_REPOSITORY_TOKEN from BullmqBatchModule`
  - Files: `packages/bullmq/src/bullmq-batch.module.ts`

- [x] 3. Fix #3: ChunkStepExecutor writeCount on skip path

  **What to do**:
  - F3 evidence: `writeCount=0` in skip scenario. 이 시나리오에서 `BatchController.importProducts` 호출 시 demo `ProductWriter`는 row 단위로 처리하면서 `DuplicateSkuError`를 throw함
  - 두 가지 접근:
    - **A**: `ProductWriter`가 skip 시 `DuplicateSkuError`를 던지지 않고 skip count를 반환하도록 변경
    - **B**: `ChunkStepExecutor`의 write phase에서 writer 결과 처리를 검증하여 `writeCount`를 정확히 누적
  - **권장**: 옵션 A — Spring Batch 패턴 준수. writer는 성공한 row 수를 반환하고, skip은 skip policy가 결정
  - 단, 이 변경은 demo 코드이므로 `ProductWriter`만 수정. core의 `ChunkStepExecutor`는 변경하지 않음

  **Root cause**:
  - `ProductWriter`는 row 단위로 돌아가서, chunk의 첫 duplicate SKU에서 `DuplicateSkuError`를 throw
  - 이로 인해 `ChunkStepExecutor`의 write phase가 fail되고 `writeCount`는 누적되지 않음
  - 그러나 live DB에서는 실제로 2개 row가 write되어야 함 (남은 valid rows)

  **Must NOT do**:
  - `ChunkStepExecutor` 변경 금지 (core API는 변경 불가)
  - chunk transaction 의미 변경 금지 (row 단위 savepoint는 유지)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: 비즈니스 로직 결정 필요

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: 5
  - **Blocked By**: None

  **References**:
  - `apps/demo/src/jobs/import-products/writer/product.writer.ts` (현재 구현)
  - `packages/core/src/execution/chunk-step-executor.ts:201-228` (write phase 처리)
  - `.omo/evidence/f3-real-qa.md` (line 19)

  **Acceptance Criteria**:
  - [ ] `ProductWriter.write(items)`가 성공한 row 수와 skip된 row 수를 반환 (예: `{ written: 2, skipped: 3 }`)
  - [ ] `DuplicateSkuError`를 throw하지 않음 — chunk 전체가 fail되지 않음
  - [ ] `pnpm --filter @nest-batch/demo test import-products.e2e`의 "Skip behavior" 시나리오 통과
  - [ ] live DB의 `batch_step_execution.write_count`가 정확함

  **QA Scenarios**:
  ```
  Scenario: ProductWriter returns skip count instead of throwing
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/demo test import-products
    Expected: exit 0, "Skip behavior" test passes
    Evidence: .omo/evidence/task-3-product-writer-skip.log

  Scenario: Live demo skip scenario has correct write_count
    Tool: Bash (curl + psql)
    Steps:
      1. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-with-errors.csv"}'
      2. PGPASSWORD=demo psql -c "SELECT read_count, write_count, skip_count FROM batch_step_execution ORDER BY id DESC LIMIT 1"
    Expected: read_count=5, write_count=2, skip_count=3
    Evidence: .omo/evidence/task-3-live-write-count.log
  ```

  **Commit**: YES
  - Message: `fix(demo): ProductWriter returns skip count instead of throwing DuplicateSkuError`
  - Files: `apps/demo/src/jobs/import-products/writer/product.writer.ts`

- [x] 4. Fix #4 + #5: Demo e2e config + library-integration import

  **What to do**:
  - **Bug #4**: `apps/demo/tests/e2e/library-integration.e2e.spec.ts:135`에서 `JobInstanceEntity` 참조하지만 import 누락. import 추가.
  - **Bug #5**: `apps/demo/vitest.e2e.config.ts`의 `include: ['tests/e2e/**/*.e2e.spec.ts']`이 `bullmq-import-products.e2e.spec.ts`도 포함. 이를 `bullmq-import-products.e2e.spec.ts`만 제외하도록 변경.
  - 또는: 별도 config (`vitest.bullmq-e2e.config.ts`)에 명시적으로 포함시키고 default e2e config에서 제외

  **Root cause**:
  - `library-integration.e2e.spec.ts`가 import 누락된 entity를 사용 → ReferenceError
  - `vitest.e2e.config.ts`가 bullmq-import-products를 잘못 포함 → BullMQ DI 에러로 worker crash

  **Must NOT do**:
  - 다른 test 파일 변경 금지
  - vitest.bullmq-e2e.config.ts 변경 금지 (의도된 분리)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: 작은 import 수정 + glob 수정

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-3)
  - **Blocks**: 5
  - **Blocked By**: None

  **References**:
  - `apps/demo/tests/e2e/library-integration.e2e.spec.ts:135` (JobInstanceEntity 사용)
  - `apps/demo/vitest.e2e.config.ts` (include glob)
  - `apps/demo/vitest.bullmq-e2e.config.ts` (별도 config)
  - `.omo/evidence/f3-real-qa.md` (lines 20-25)

  **Acceptance Criteria**:
  - [ ] `library-integration.e2e.spec.ts`에서 import 추가
  - [ ] `pnpm --filter @nest-batch/demo test:e2e`의 include에서 bullmq 제외
  - [ ] `pnpm --filter @nest-batch/demo test:e2e` 실행 시 더 이상 worker crash 없음

  **QA Scenarios**:
  ```
  Scenario: library-integration e2e import fix
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/demo test:e2e
    Expected: exit 0, no ReferenceError
    Evidence: .omo/evidence/task-4-library-integration-import.log

  Scenario: vitest.e2e.config excludes bullmq
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/demo test:e2e
    Expected: exit 0, no DI error
    Evidence: .omo/evidence/task-4-e2e-config.log
  ```

  **Commit**: YES
  - Message: `fix(demo): add missing JobInstanceEntity import and exclude bullmq e2e from default config`
  - Files: `apps/demo/tests/e2e/library-integration.e2e.spec.ts`, `apps/demo/vitest.e2e.config.ts`

### Wave 2 — VERIFICATION

- [x] 5. Re-run F3 scenarios with all fixes applied

  **What to do**:
  - `pnpm --filter @nest-batch/core test` → 532/532 pass
  - `pnpm --filter @nest-batch/bullmq test` → 6/6 pass (DB-first execution 포함)
  - `pnpm --filter @nest-batch/demo test:e2e` → 10/10 pass (skip behavior 포함)
  - `pnpm --filter @nest-batch/demo test:bullmq-e2e` → bullmq-import-products 통과
  - live demo in-process 모드: import-products 호출 후 `exit_code='COMPLETED'` 검증
  - live demo bullmq 모드: BATCH_TRANSPORT=bullmq 부팅 + import-products 호출 + `exit_code='COMPLETED'` 검증

  **Must NOT do**:
  - 새 코드 변경 금지
  - 새 의존성 추가 금지

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: 다중 패키지 통합 검증

  **Parallelization**:
  - **Can Run In Parallel**: NO (순차 검증)
  - **Parallel Group**: Wave 2
  - **Blocks**: 6
  - **Blocked By**: 1, 2, 3, 4

  **References**:
  - All Wave 1 fixes
  - `.omo/evidence/f3-real-qa.md`

  **Acceptance Criteria**:
  - [ ] core tests: 532/532 pass
  - [ ] bullmq tests: 6/6 pass
  - [ ] demo e2e tests: 10/10 pass (skip behavior 포함)
  - [ ] bullmq-import-products e2e: 통과
  - [ ] live demo in-process: `exit_code='COMPLETED'`
  - [ ] live demo bullmq: 부팅 성공 + `exit_code='COMPLETED'`

  **QA Scenarios**:
  ```
  Scenario: All package tests pass
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/core test
      2. pnpm --filter @nest-batch/bullmq test
      3. pnpm --filter @nest-batch/demo test:e2e
    Expected: all exit 0
    Evidence: .omo/evidence/task-5-all-tests.log

  Scenario: Live demo in-process COMPLETED
    Tool: Bash (curl + psql)
    Steps:
      1. pnpm --filter @nest-batch/demo start:dev &
      2. sleep 5
      3. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
      4. PGPASSWORD=demo psql -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
    Expected: status=COMPLETED, exit_code='COMPLETED'
    Evidence: .omo/evidence/task-5-live-inprocess.log

  Scenario: Live demo bullmq COMPLETED
    Tool: Bash (curl + psql)
    Preconditions: Redis :6379
    Steps:
      1. BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1 pnpm --filter @nest-batch/demo start:dev &
      2. sleep 8
      3. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
      4. sleep 3
      5. PGPASSWORD=demo psql -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
    Expected: status=COMPLETED, exit_code='COMPLETED'
    Evidence: .omo/evidence/task-5-live-bullmq.log
  ```

  **Commit**: NO (검증만)

- [x] 6. Final documentation and evidence consolidation

  **What to do**:
  - 모든 evidence 파일을 `.omo/evidence/`에 정리
  - F3 재검증 보고서 작성: `.omo/evidence/f3-rerun-real-qa.md`
  - 최종 보고서 작성: `.omo/evidence/FINAL-FIX-REPORT.md`
  - README 업데이트 (선택): DoD #6 충족 사실 반영

  **Must NOT do**:
  - 새 기능 추가 금지
  - 광범위한 문서 재작성 금지

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: 문서 정리

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: 7
  - **Blocked By**: 5

  **Acceptance Criteria**:
  - [ ] `.omo/evidence/`에 모든 task의 evidence 파일 존재
  - [ ] `.omo/evidence/f3-rerun-real-qa.md` 작성 (F3 REJECT 사유가 모두 해결되었음을 입증)
  - [ ] `.omo/evidence/FINAL-FIX-REPORT.md` 작성

  **QA Scenarios**:
  ```
  Scenario: Evidence files exist
    Tool: Bash
    Steps:
      1. ls .omo/evidence/task-1-* .omo/evidence/task-2-* .omo/evidence/task-3-* .omo/evidence/task-4-* .omo/evidence/task-5-* .omo/evidence/f3-rerun-real-qa.md
    Expected: all files present
    Evidence: .omo/evidence/task-6-evidence-summary.log
  ```

  **Commit**: YES
  - Message: `docs: add final F3 re-verification evidence`
  - Files: `.omo/evidence/f3-rerun-real-qa.md`, `.omo/evidence/FINAL-FIX-REPORT.md`

---

## Commit Strategy

- **1**: `fix(core): set JobExecutor exitCode='COMPLETED' on success path`
- **2**: `fix(bullmq): export JOB_REPOSITORY_TOKEN from BullmqBatchModule`
- **3**: `fix(demo): ProductWriter returns skip count instead of throwing DuplicateSkuError`
- **4**: `fix(demo): add missing JobInstanceEntity import and exclude bullmq e2e from default config`
- **6**: `docs: add final F3 re-verification evidence`

---

## Success Criteria

### Verification Commands

```bash
# All tests
pnpm --filter @nest-batch/core test
pnpm --filter @nest-batch/bullmq test
pnpm --filter @nest-batch/mikro-orm test
pnpm --filter @nest-batch/typeorm test
pnpm --filter @nest-batch/demo test
pnpm --filter @nest-batch/demo test:e2e
pnpm --filter @nest-batch/demo test:bullmq-e2e

# Build
pnpm build

# Typecheck
pnpm typecheck

# Live verification
docker compose up -d postgres redis
pnpm --filter @nest-batch/demo migration:up
BATCH_TRANSPORT=in-process pnpm --filter @nest-batch/demo start:dev &
sleep 5
curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
PGPASSWORD=demo psql -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
# Expected: status=COMPLETED, exit_code='COMPLETED'
```

### Final Checklist
- [ ] All 4 critical bug fixes applied and tested
- [ ] JobExecutor sets exitCode='COMPLETED' on success path
- [ ] BullmqBatchModule exports JOB_REPOSITORY_TOKEN
- [ ] ProductWriter returns skip count instead of throwing
- [ ] library-integration.e2e.spec.ts has correct imports
- [ ] vitest.e2e.config.ts excludes bullmq-import-products
- [ ] All package tests pass
- [ ] Live demo: COMPLETED jobs have exit_code='COMPLETED'
- [ ] Live demo: BATCH_TRANSPORT=bullmq boots successfully
- [ ] F3 REJECT items all resolved

---

## FOLLOW-UP REQUIRED

> **Status:** REJECTED — DoD #6 is **not** met. The plan landed 4 of 5 fixes correctly, but Fix #2 (BullmqBatchModule DI for `JOB_REPOSITORY_TOKEN`) was implemented as a doc-only update and did not change runtime behavior. A new task is required before this plan can be closed.

### Bug #2 is NOT actually fixed

The original F3 Real Manual QA flagged Bug #2 as **CRITICAL #1** — the live demo in `BATCH_TRANSPORT=bullmq` mode crashes with `UnknownDependenciesException` during `NestFactory.create` because `BullmqRuntimeService` cannot resolve `JOB_REPOSITORY_TOKEN`. The plan's Task 2 added explanatory comments to `packages/bullmq/src/bullmq-batch.module.ts` describing the "global module chain" — but did not change any binding, export, or injection token. The exception still occurs.

Evidence: `.omo/evidence/task-5-demo-bullmq.log` and `.omo/evidence/task-5-bullmq-e2e.log` show the same `UnknownDependenciesException` raised in both the live demo and the `test:e2e:bullmq` suite, with the same module and token the original F3 reported.

### Root cause (verified by reading the source, not just by reading the error)

The plan's doc-only fix assumed that `NestBatchModule`'s `global: true` scope would bridge the DI graph for `BullmqBatchModule`. That assumption is correct **in principle** — but only if the binding under the symbol key actually exists. It does not, because of a token identity mismatch:

- `packages/bullmq/src/bullmq-runtime.service.ts:148` injects the **symbol** token:
  ```ts
  @Inject(JOB_REPOSITORY_TOKEN)  // Symbol.for('@nest-batch/core/JOB_REPOSITORY')
  ```
- `apps/demo/src/app.module.ts` wires the binding to the **class** token:
  ```ts
  NestBatchModule.forRoot({
    repository: { provide: JobRepository, useClass: MikroORMJobRepository },
    //                                ^^^^^^^^^^^^ class, not JOB_REPOSITORY_TOKEN
  })
  ```
- `packages/core/src/module/nest-batch.module.ts:514-516` adds the **class** to `exports` (via `extractToken(repository).provide`), never the symbol.

Result: `BullmqRuntimeService` cannot resolve `JOB_REPOSITORY_TOKEN`. The "global module chain" the fix's doc comment describes does not bridge a symbol↔class gap; the binding literally does not exist under that key. `UnknownDependenciesException` is the correct, deterministic outcome of this mis-wiring. The fix proposed in this plan did not address the cause.

### Three possible code-level fixes (any one of which would resolve Bug #2)

**Option A — Fix the demo (cheapest, smallest diff, recommended for the immediate unblock):**
Change `apps/demo/src/app.module.ts` to bind the repository to the symbol, not the class:
```ts
NestBatchModule.forRoot({
  repository: { provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository },
  //                                ^^^^^^^^^^^^^^^^^ symbol, matches the runtime's @Inject
})
```
One-line change in the demo. No library changes required. The class-typed binding was the wrong key from the start.

**Option B — Fix the runtime to inject the class:**
Change `packages/bullmq/src/bullmq-runtime.service.ts:148` from
```ts
@Inject(JOB_REPOSITORY_TOKEN) private readonly jobRepository: JobRepository,
```
to
```ts
@Inject(JobRepository) private readonly jobRepository: JobRepository,
```
Aligns the runtime with what the demo (and any other consumer) already wires. Requires care so that consumers who bind to the symbol still resolve.

**Option C — Fix the library to export the symbol and migrate the demo:**
- Add `JOB_REPOSITORY_TOKEN` to `packages/core/src/module/nest-batch.module.ts` exports unconditionally (not gated on what the user passed in `repository.provide`).
- Update `apps/demo/src/app.module.ts` to use the symbol: `{ provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository }`.
- Most defensive option: the contract is now explicit on the library side and the symbol↔class mismatch cannot recur in another host application.

**Recommendation:** Option A for the immediate unblock (smallest diff, fastest to verify against the existing live-demo gate). Option C if there is appetite to harden the library contract so this regression class cannot reappear in another consumer.

### Status

- **Fix #2 in this plan:** REJECTED. Doc-only; the underlying DI bug is unchanged.
- **DoD #6 ("Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories"):** **NOT MET.** The bullmq live demo cannot reach the state-writing stage at all — the worker process crashes on startup with `UnknownDependenciesException`.
- **Tests passing:** 572 (533 core + 6 bullmq + 19 demo unit + 14 demo e2e). Zero regressions across the four green suites.
- **Tests failing:** `pnpm --filter @nest-batch/demo test:e2e:bullmq` (3 tests, 1 unhandled error, exit 1) and the live bullmq demo (does not boot).
- **Required follow-up:** A new task must (1) pick one of Options A / B / C, (2) land the corresponding code change + a regression test that boots `AppModule` with `BATCH_TRANSPORT=bullmq` against real Postgres + Redis, (3) re-run the F3 live-demo bullmq scenario and `test:e2e:bullmq` to confirm the green path, and (4) add `test:e2e:bullmq` to CI so this regression class is caught at PR time, not in a manual F3 rerun.

The companion summary report for the whole plan lives at `.omo/evidence/FINAL-FIX-REPORT.md`.
