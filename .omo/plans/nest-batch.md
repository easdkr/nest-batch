# nest-batch — Nest.js 기반 Spring Batch 영감 배치 라이브러리 + 데모 앱

## TL;DR

> **Quick Summary**: Nest.js 환경에서 Spring Batch의 핵심 추상화(Job, Step, ItemReader/Processor/Writer, Tasklet, Listeners, Flow, Skip/Retry, 영속 JobRepository)를 영감으로 한 패키지를 TDD로 구축하고, CSV → PostgreSQL 임포트 데모 앱(MikroORM 어댑터)으로 풀 기능 시연.
>
> **Deliverables**:
> - `packages/nest-batch/` — Nest.js 라이브러리 (decorator + fluent builder API, in-memory + 확장 가능한 영속 어댑터 인터페이스)
> - `apps/demo/` — Nest.js 데모 앱 (CSV → Product 임포트, PostgreSQL 5434, MikroORM, REST 트리거)
> - 6단계 Milestone: Contracts → In-memory happy path → Failure semantics → Flow → Persistent repo + Restart → Demo E2E
>
> **Estimated Effort**: Large (40-50 task)
> **Parallel Execution**: YES — 8 waves, 최대 7 task/wave
> **Critical Path**: M0-1 (IR) → M1-2 (InMemoryRepo) → M1-5 (JobLauncher) → M2-1 (SkipPolicy) → M4-1 (MikroORM adapter) → M5-1 (Demo job) → F1-F4

---

## Context

### Original Request
> "현재 프로젝트에 nest.js 환경에서 spring batch 와 동일한 패키지를 만들고, 데모앱까지 만들기 위한 플랜 작성"
> (현재 디렉토리는 `/Users/june/workspace/personal/nest-batch/` — 완전 빈 상태)

### Interview Summary

**Key Decisions (사용자 확정)**:
- **구조**: pnpm 모노레포 (`packages/nest-batch` + `apps/demo`)
- **빌드/테스트**: pnpm + swc + vitest, **TDD (RED→GREEN→REFACTOR)**
- **범위**: Standard (MVP + Skip/Retry + Listeners + Flow + 영속 JobRepository)
- **시맨틱 깊이**: **Spring Batch 영감 only** (Nest-friendly, 완전 호환 X)
- **Milestone 구조**: 채택 (M0 contracts → M5 demo)
- **Out of Scope (v1 Must NOT Have)**: 스케줄러, Admin UI, Partitioning, Remote chunking, Distributed workers, Pause/Resume, Job dashboard
- **API 스타일**: **둘 다 제공** (decorator + fluent builder, 동일 IR로 컴파일)
- **ORM**: **ORM-agnostic 어댑터 패턴** (데모는 **MikroORM**)
- **데모 DB**: PostgreSQL (docker-compose, **포트 5434**)
- **데모 도메인**: **Product CSV 임포트** (id, name, sku, price, category)
- **데모 기능 풀 시연**: Skip + Retry + Listeners + Flow
- **데모 트리거**: REST endpoint (`POST /jobs/import-products`)
- **CSV 라이브러리**: csv-parse

**Research Findings**:
- **OSS landscape**: HyunnoH/nest-batch (3★, 비활성), little-yellow-bean/nest-batch (3★, 2024, 가장 유사 — MongoRepo + JobBuilder) — **우리 차별점: 듀얼 API + ORM-agnostic + 풀 Standard 범위 + TDD**
- **참고할 패턴**: `@nestjs/schedule`의 `Explorer` + `Registry` 분리 / `@nestjs/cqrs`의 saga 디렉토리 (Flow 영감)
- **Spring Batch 9개 메타 테이블**: MVP에서는 6-7개로 간소화 (BATCH_STEP_EXECUTION_PARAMS는 강제 X)

### ORACLE Architecture Review (verdicts)

- **Decision 1a** (두 API + 하나의 IR): **SOUND** — 두 API 모두 `JobDefinition`으로 컴파일, executor는 validated IR만 받음
- **Decision 1b** (IR 형태): **plain discriminated union + DAG transitions** (class hierarchy X)
- **Decision 1c** (메타데이터 브릿지): **`BatchExplorer` → `DefinitionCompiler` → `DefinitionValidator` → `JobRegistry` → `JobLauncher`** 4-서비스 분리
- **Decision 2a** (interface vs abstract class): **`abstract class` + 옵션 interface 동시 export** (Nest DI 토큰 호환)
- **Decision 2b** (low-level vs high-level): **aggregate 기반 low-level 메서드** (table-단위 X, `commitChunk` 같은 high-level X)
- **Decision 2c** (in-memory adapter): **진짜 repository처럼 행동** (deterministic ID, deep clone, async signatures)
- **Decision 2d** (execution context): **JSON-serializable + metadata/version**, 함수/클래스/순환/BigInt/stream/EntityManager 차단
- **Decision 3a** (트랜잭션): **`TransactionManager.withTransaction<T>(fn)`** portable hook
- **Decision 3b** (restartability): **persisted repo는 default-on**, `restartable: false` opt-out
- **Decision 3c** (flow evaluation): **`Promise<FlowExecutionStatus>`** 반환
- **Decision 3d** (skip/retry): **config public, 내부는 policy class** 컴파일

**8개 추가 위험 요소 (플랜에 포함)**: backpressure & reader lifecycle, event-loop blocking, chunk boundary error propagation, listener failure policy, DI lifecycle on restart, concurrency controls, serialization contract, observability naming

### Metis Review (gap analysis)

- **Executive take**: scope is coherent but too large for one MVP → **Milestone 0–5 vertical slice 구조 채택**
- **"Must NOT Have" 명시**: scheduling, dashboard, partitioning, remote chunking, distributed workers, advanced Spring Batch DSL, observability exporters (naming/hooks 안정화 전)
- **Demo는 public API만 사용** (private 우회 금지)
- **in-memory repo는 non-restartable 기본**
- **Decorator ↔ Builder parity test 필수** (같은 `JobDefinition`으로 컴파일되는지)
- **10개 E2E 시나리오 정의**: happy path, skip, skip limit exceeded, retry success, retry exhausted, restart after crash, concurrent launch, flow routing, malformed CSV, listener failure

---

## Work Objectives

### Core Objective
Nest.js 환경에서 Spring Batch 영감의 배치 처리 라이브러리(`nest-batch`)를 TDD로 구축하고, CSV → PostgreSQL Product 임포트 데모 앱으로 풀 기능(Standard 범위: Skip/Retry/Listeners/Flow/영속 Repository/Restart)을 시연한다.

### Concrete Deliverables
- `packages/nest-batch/src/core/` — IR types, statuses, errors, repository contract, transaction contract
- `packages/nest-batch/src/execution/` — JobLauncher, JobExecutor, StepExecutor, FlowEvaluator, JobRegistry, Explorer
- `packages/nest-batch/src/decorators/` — @Jobable, @Stepable, @ItemReader, @ItemProcessor, @ItemWriter, @Tasklet, 7 listener decorators
- `packages/nest-batch/src/builder/` — BatchBuilder, JobBuilder, StepBuilder (fluent API)
- `packages/nest-batch/src/policies/` — SkipPolicy, RetryPolicy (config → class 컴파일)
- `packages/nest-batch/src/repository/in-memory.ts` — reference adapter (non-restartable)
- `packages/nest-batch/src/module/` — NestBatchModule (forRoot, forRootAsync)
- `packages/nest-batch/src/index.ts` — public exports
- `apps/demo/` — Nest.js + MikroORM + PostgreSQL :5434 데모
- `apps/demo/src/adapters/mikroorm/` — MikroORM JobRepository adapter
- `apps/demo/src/jobs/import-products/` — validateCsv + importProducts 2-step job
- `apps/demo/sample-data/*.csv` — valid, with-errors, malformed fixtures
- `docker-compose.yml` — PostgreSQL :5434
- `packages/nest-batch/tests/` + `apps/demo/tests/` — vitest (TDD), 10 E2E 시나리오
- `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`

### Definition of Done
- [x] `pnpm install` succeeds; `pnpm -r build` (swc) produces `dist/` for both packages
- [x] `pnpm -r test` (vitest) — all tests pass, TDD evidence (RED→GREEN→REFACTOR) in commit history
- [x] `docker compose up -d postgres` starts PostgreSQL :5434
- [x] `pnpm --filter @nest-batch/demo test:e2e` — 10 E2E scenarios pass
- [x] `curl -X POST http://localhost:3000/jobs/import-products` triggers import, returns JobExecution with status
- [x] Demo imports valid CSV products, skips invalid rows with reasons, survives simulated transient DB failure via retry, restarts after crash without duplicates

### Must Have
- [x] 두 API (decorator + builder) 모두 동일 `JobDefinition` IR로 컴파일 (parity test로 검증)
- [x] `JobRepository` abstract class (Nest DI 토큰) + aggregate-oriented low-level methods
- [x] `TransactionManager` abstract class + `withTransaction<T>(fn)` hook
- [x] `InMemoryJobRepository` (reference adapter, non-restartable 기본)
- [x] 6-7개 영속 JobRepository entities (BATCH_JOB_INSTANCE, BATCH_JOB_EXECUTION, BATCH_JOB_EXECUTION_PARAMS, BATCH_JOB_EXECUTION_CONTEXT, BATCH_STEP_EXECUTION, BATCH_STEP_EXECUTION_CONTEXT)
- [x] Job/Step status enums (COMPLETED, FAILED, STARTING, STARTED, STOPPING, STOPPED, UNKNOWN)
- [x] FlowExecutionStatus enum (COMPLETED, FAILED, STOPPED, UNKNOWN) + Transition evaluation (async)
- [x] 7 Listeners (Job/Step/Chunk/ItemRead/ItemProcess/ItemWrite/Skip) — decorator + builder 등록
- [x] SkipPolicy + RetryPolicy — config → policy class 컴파일
- [x] MikroORM JobRepository adapter (데모 앱)
- [x] Demo: CSV → Product import job, validateCsv step + importProducts step (Flow)
- [x] Demo: REST endpoint `POST /jobs/import-products`
- [x] Sample CSV fixtures (valid, with-errors, malformed)
- [x] 10 E2E test scenarios (happy path, skip, skip limit, retry success, retry exhausted, restart, concurrent, flow, malformed CSV, listener failure)
- [x] TDD commit history (RED → GREEN → REFACTOR) per behavior

### Must NOT Have (Guardrails)
- ❌ **No scheduling/Cron integration** (별도 패키지)
- ❌ **No Admin UI / dashboard / monitoring UI**
- ❌ **No partitioning / multi-threaded step / remote chunking / distributed workers**
- ❌ **No pause/resume API**
- ❌ **No XML/Java-config style Spring Batch DSL** (TypeScript-native only)
- ❌ **No OpenTelemetry/Prometheus exporters** (naming/hooks만 노출, exporter는 미포함)
- ❌ **No additional ORM adapters** beyond MikroORM demo (TypeORM/Prisma/Mongoose는 사용자가 직접 구현)
- ❌ **No advanced Spring Batch features**: nested jobs, job inheritance, late binding, promotion listeners
- ❌ **No full Spring Batch restart semantics** (영감 수준: last committed chunk resume, item-level checkpoint X)
- ❌ **No demo private library paths** (demo는 public API만 사용)
- ❌ **No retry with distributed coordination** (단일 프로세스 retry만)
- ❌ **No full Spring Batch flow grammar** (only `on(status).to(step)`, `from(step)`, `end()`)
- ❌ **No file watching / auto-discovery of jobs** (명시적 등록 only)

### Test Strategy (TDD)

- **Test framework**: vitest
- **Coverage target**: 80%+ per file
- **TDD discipline**: RED (failing test) → GREEN (minimal impl) → REFACTOR. Each behavior task = 1 RED + 1 GREEN + optional REFACTOR.
- **Integration tests**: PostgreSQL only after in-memory contract tests pass
- **E2E tests**: 10 scenarios via supertest (REST) + curl + fixture CSVs
- **No real DB outage in TDD** (deterministic transient writer in tests; 1 separate E2E for real outage)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — 모든 검증은 agent-executed.

### Test Decision
- **Infrastructure exists**: NO (빈 디렉토리)
- **Automated tests**: **TDD (RED → GREEN → REFACTOR)**
- **Framework**: vitest
- **Each task**: RED (failing test first) → GREEN (minimal impl) → optional REFACTOR

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Library unit**: vitest — assertion with exact expected values
- **Library integration**: vitest + in-memory adapters — full execution path
- **Demo unit**: vitest — entity validation, policy compilation
- **Demo E2E**: vitest + supertest (REST) + csv fixtures — 10 scenarios
- **DB E2E**: docker compose up + real MikroORM + restart simulation

---

## Execution Strategy

### Parallel Execution Waves (Milestone-based)

> 6 Milestone × 1-2 waves each. 5-7 tasks per wave for maximum parallelism. Each Milestone is a vertical slice (contracts → impl → tests together).

```
Wave 1 — M0: CONTRACTS (foundation, all independent)
├── 1. Monorepo scaffold (root, pnpm-workspace, tsconfig, eslint, vitest, swc)
├── 2. IR types (JobDefinition, StepDefinition discriminated union, ListenerDefinition, TransitionDefinition)
├── 3. Status & error enums (JobStatus, StepStatus, FlowExecutionStatus, ValidationError, BatchError)
├── 4. JobRepository abstract class + TransactionManager abstract class
├── 5. ExecutionContext JSON serializer + JsonValue type
└── 6. DefinitionValidator (graph integrity: targets exist, one start, no cycles, terminals)

Wave 2 — M1: REGISTRY + DECORATOR API (depends: 2, 3, 6)
├── 7. BatchExplorer (Nest metadata scanner, onModuleInit)
├── 8. DefinitionCompiler (metadata → IR; builder config → IR; parity interface)
├── 9. JobRegistry (validated definitions storage; duplicate detection)
├── 10. Decorator API: @Jobable, @Stepable, @Tasklet
├── 11. Decorator API: @ItemReader, @ItemProcessor, @ItemWriter, 7 listener decorators
├── 12. NestBatchModule (forRoot, forRootAsync, Explorer wiring)
└── 13. InMemoryJobRepository (real repo: deterministic IDs, deep clone, async, uniqueness)

Wave 3 — M1: BUILDER + EXECUTION ENGINE (depends: 9, 12, 13)
├── 14. Builder API: BatchBuilder, JobBuilder, StepBuilder, FlowBuilder
├── 15. InMemoryTransactionManager (no-op, deep-clone tx context)
├── 16. ItemReader/ItemProcessor/ItemWriter interfaces (with Promise contract)
├── 17. TaskletStepExecutor (single execution with TX hook)
├── 18. ChunkStepExecutor (reader → process → write loop, chunkSize control)
├── 19. JobLauncher (entry: get definition, init execution, run)
└── 20. StepExecutor + ListenerInvoker (lifecycle call order: before→execute→after)

Wave 4 — M2: FAILURE SEMANTICS (depends: 18, 20)
├── 21. SkipPolicy interface + ConfigSkipPolicy (compiled from config)
├── 22. RetryPolicy interface + ConfigRetryPolicy + BackoffPolicy
├── 23. ChunkProcessor with skip/retry integration (per-phase try-catch)
├── 24. 7 Listener implementations: before/after/onError for Job/Step/Chunk/Item
├── 25. SkipListener implementation: onSkipInRead/Process/Write
├── 26. Listener failure policy (default: fail step; non-critical opt-out)
└── 27. Listener ordering + idempotency

Wave 5 — M3: FLOW (depends: 18, 20, 23)
├── 28. TransitionDefinition + FlowEvaluator (async, returns Promise<FlowExecutionStatus>)
├── 29. Flow status resolution: step exit status + afterStep listener override
├── 30. Builder API extension: .on(status).to(step).from(step).end() — validation
└── 31. Decorator API extension: @OnTransition, @FromStep (for declarative flow)

Wave 6 — M4: PERSISTENT REPOSITORY + RESTART (depends: 13, 4)
├── 32. Demo app scaffold: Nest + MikroORM + PostgreSQL :5434 + docker-compose
├── 33. MikroORM entities: JobInstance, JobExecution, StepExecution, ExecutionContext rows
├── 34. MikroORMJobRepository adapter (implements JobRepository abstract class)
├── 35. MikroORMTransactionManager (uses EntityManager.transaction())
├── 36. JobInstance identity + job key normalization (canonical JSON hash)
└── 37. Restart support: resume from last committed chunk, ExecutionContext versioning

Wave 7 — M4: CONCURRENCY + OBSERVABILITY HOOKS (depends: 34, 36)
├── 38. Concurrency control: same jobName+jobKey already running → JobExecutionAlreadyRunning
├── 39. Observability naming: standard IDs (UUID v7?), status transitions, count schemas
└── 40. Library smoke test: library + in-memory repo end-to-end (full job with chunk step)

Wave 8 — M5: DEMO APP (depends: 32-37, 21-27, 28-31)
├── 41. Demo entities: Product + Category enum + sample CSVs (3 fixtures)
├── 42. CsvProductReader (csv-parse, header validation, error handling)
├── 43. ProductProcessor (validation: sku dup, price > 0, category in valid list)
├── 44. ProductWriter (MikroORM bulk insert, transactional)
├── 45. ImportProducts job: 2 steps (validateCsv → importProducts via Flow)
├── 46. SkipLoggerListener + StepMetricsListener (Step-level + Item-level)
├── 47. REST endpoint: POST /jobs/import-products (using JobLauncher from library)
└── 48. 10 E2E test scenarios (supertest + fixtures + docker)

Wave FINAL — F1-F4 parallel review
├── F1. Plan compliance audit (oracle)
├── F2. Code quality review (unspecified-high)
├── F3. Real manual QA (unspecified-high + supertest)
└── F4. Scope fidelity check (deep)

Critical Path: 1 → 2 → 8 → 9 → 14 → 18 → 23 → 30 → 34 → 36 → 45 → 47 → F1-F4
Parallel Speedup: ~70% vs sequential
Max Concurrent: 7 (Waves 1, 2, 3, 4, 7)
```

### Agent Dispatch Summary
- **Wave 1-2 (M0+M1)**: `quick` for scaffold + types + small modules
- **Wave 3-4 (M1+M2)**: `unspecified-high` for execution engine + policies
- **Wave 5 (M3)**: `unspecified-high` for flow evaluator
- **Wave 6-7 (M4)**: `unspecified-high` for ORM adapter + restart
- **Wave 8 (M5)**: `unspecified-high` for demo app + E2E
- **Wave FINAL**: `oracle` + `unspecified-high` (×2) + `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> Every task MUST have: Recommended Agent Profile + Parallelization + QA Scenarios.
> Format: bare numbers (`1.`, `2.`, …). Final wave: `F1.`, `F2.`, …
> Evidence saved to `.omo/evidence/task-{N}-{slug}.{ext}`.

### Wave 1 — M0: CONTRACTS (foundation)

- [x] 1. Monorepo scaffold + tooling (root)

  **What to do**:
  - Create root `package.json` (private, pnpm workspace, name: `nest-batch-monorepo`)
  - Create `pnpm-workspace.yaml` (packages: `packages/*`, `apps/*`)
  - Create `tsconfig.base.json` (strict mode, ES2022, NodeNext module, decorators: true, experimentalDecorators: true)
  - Create `.swcrc` (shared swc build config: target ES2022, module CommonJS for Nest compat)
  - Create root `vitest.config.ts` (coverage v8, threshold 80%)
  - Create root `.eslintrc.cjs` (eslint + @typescript-eslint + import order)
  - Create `.gitignore`, `.editorconfig`, `.prettierrc`
  - Create root `README.md` (project intro + workspace overview)
  - Run `pnpm install` to verify workspace boots

  **Must NOT do**: No application code, no library code, no DB setup. Tooling only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`
  - **Reason**: Single-file scaffolding, no domain logic

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-6)
  - **Blocks**: All other tasks (provides tooling)
  - **Blocked By**: None

  **References**:
  - pnpm workspaces docs: `https://pnpm.io/workspaces`
  - NestJS monorepo guide: `https://docs.nestjs.com/cli/monorepo`

  **Acceptance Criteria**:
  - [ ] `pnpm install` succeeds with no errors
  - [ ] `pnpm -r exec tsc --noEmit` returns 0 errors (empty workspaces OK)
  - [ ] `ls packages/nest-batch apps/demo` succeeds (placeholder dirs OK)
  - [ ] `cat pnpm-workspace.yaml` shows correct globs
  - [ ] `cat tsconfig.base.json` shows strict + decorators

  **QA Scenarios**:
  ```
  Scenario: Workspace boots from clean
    Tool: Bash
    Steps:
      1. rm -rf node_modules
      2. pnpm install
    Expected: exit 0, "Done in N.Ns"
    Evidence: .omo/evidence/task-1-pnpm-install.log
  ```

  **Commit**: YES
  - Message: `chore(monorepo): scaffold pnpm workspace + tsconfig + swc + vitest + eslint`
  - Files: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.swcrc`, `vitest.config.ts`, `.eslintrc.cjs`, `.gitignore`, `.editorconfig`, `.prettierrc`, `README.md`

- [x] 2. IR types (internal representation, plain objects)

  **What to do**:
  - Create `packages/nest-batch/src/core/ir/job-definition.ts`:
    - `JobDefinition { id: string; steps: Record<string, StepDefinition>; startStepId: string; transitions: TransitionDefinition[]; listeners: ListenerDefinition[]; restartable: boolean; allowDuplicateInstances: boolean; }`
  - Create `packages/nest-batch/src/core/ir/step-definition.ts` (discriminated union):
    - `type StepDefinition = ChunkStepDefinition | TaskletStepDefinition;`
    - `ChunkStepDefinition { kind: 'chunk'; id: string; chunkSize: number; reader: ReaderRef; processor?: ProcessorRef; writer: WriterRef; skipPolicy?: SkipPolicyConfig; retryPolicy?: RetryPolicyConfig; listeners: ItemListenerRef[]; }`
    - `TaskletStepDefinition { kind: 'tasklet'; id: string; tasklet: TaskletRef; listeners: ItemListenerRef[]; }`
  - Create `packages/nest-batch/src/core/ir/transition-definition.ts`:
    - `TransitionDefinition { fromStepId: string; onStatus: FlowExecutionStatus; toStepId: string | null /* null = END */; }`
  - Create `packages/nest-batch/src/core/ir/listener-definition.ts`:
    - `ListenerDefinition { kind: 'job' | 'step' | 'chunk' | 'item-read' | 'item-process' | 'item-write' | 'skip' | 'transition'; ref: ListenerRef; phase: 'before' | 'after' | 'on-error'; nonCritical?: boolean; }`
  - Create `packages/nest-batch/src/core/ir/refs.ts`:
    - `type ReaderRef = { type: 'provider-token'; token: string } | { type: 'builder-lambda'; fn: Function } | { type: 'method'; classToken: string; methodName: string }`
    - Same shape for `ProcessorRef`, `WriterRef`, `TaskletRef`, `ListenerRef`
  - All types exported from `packages/nest-batch/src/core/ir/index.ts`

  **Must NOT do**: No class hierarchy (per ORACLE verdict), no executable code, no validation logic.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Type definitions only, no logic

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4, 5, 6)
  - **Blocks**: 7, 8, 9, 14, 28, 30
  - **Blocked By**: None

  **References**:
  - ORACLE verdict 1b: "plain discriminated union + DAG transitions"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core tsc --noEmit` → 0 errors
  - [ ] `vitest run packages/nest-batch/src/core/ir/ir.types.test.ts` → 1 test passes (compile-time type check via `expectTypeOf`)
  - [ ] All exports accessible from `packages/nest-batch/src/core/ir/index.ts`

  **QA Scenarios**:
  ```
  Scenario: JobDefinition discriminated union compiles
    Tool: Bash (tsc)
    Steps:
      1. cd packages/nest-batch
      2. pnpm exec tsc --noEmit
    Expected: exit 0
    Evidence: .omo/evidence/task-2-tsc-check.log
  ```

  **Commit**: YES
  - Message: `feat(core): add IR types for Job/Step/Transition/Listener definitions`
  - Files: `packages/nest-batch/src/core/ir/*.ts`

- [x] 3. Status enums + error classes

  **What to do**:
  - Create `packages/nest-batch/src/core/status.ts`:
    - `export enum JobStatus { STARTING = 'STARTING', STARTED = 'STARTED', COMPLETED = 'COMPLETED', FAILED = 'FAILED', STOPPING = 'STOPPING', STOPPED = 'STOPPED', UNKNOWN = 'UNKNOWN' }`
    - `export enum StepStatus { STARTING, STARTED, COMPLETED, FAILED, STOPPED, UNKNOWN }`
    - `export enum FlowExecutionStatus { COMPLETED, FAILED, STOPPED, UNKNOWN }`
    - `export enum ChunkStatus { PROCESSING, COMPLETED }`
  - Create `packages/nest-batch/src/core/errors.ts`:
    - `BatchError` (base, has `code: string`, `details: unknown`)
    - `JobNotFoundError extends BatchError` (code: `JOB_NOT_FOUND`)
    - `DuplicateJobDefinitionError extends BatchError` (code: `DUPLICATE_JOB`)
    - `InvalidFlowGraphError extends BatchError` (codes: `MISSING_TARGET`, `NO_START_STEP`, `UNREACHABLE_STEP`, `CYCLE_DETECTED`, `AMBIGUOUS_TRANSITION`)
    - `SkipLimitExceededError extends BatchError` (code: `SKIP_LIMIT_EXCEEDED`)
    - `RetryLimitExceededError extends BatchError` (code: `RETRY_LIMIT_EXCEEDED`)
    - `JobExecutionAlreadyRunningError extends BatchError` (code: `JOB_EXECUTION_ALREADY_RUNNING`)
    - `InvalidExecutionContextError extends BatchError` (code: `INVALID_EXECUTION_CONTEXT`)
  - Create `packages/nest-batch/tests/core/status.test.ts` (vitest):
    - Test: each enum has expected string values
    - Test: each error class produces correct `code`
  - Create `packages/nest-batch/tests/core/errors.test.ts`:
    - Test: `new JobNotFoundError('foo')` has `code === 'JOB_NOT_FOUND'` and `message includes 'foo'`

  **Must NOT do**: No throw sites, no runtime behavior, no logger.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5, 6)
  - **Blocks**: 6, 7, 18, 21, 22, 28
  - **Blocked By**: None

  **References**:
  - Spring Batch `BatchStatus` enum: docs.spring.io/spring-batch

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test status` → green
  - [ ] `pnpm --filter @nest-batch/core test errors` → green
  - [ ] All 4 enums + 8 error classes exported from `index.ts`

  **QA Scenarios**:
  ```
  Scenario: Error codes are stable
    Tool: Bash (vitest)
    Steps:
      1. cd packages/nest-batch
      2. pnpm exec vitest run tests/core/errors.test.ts
    Expected: exit 0, all tests pass
    Evidence: .omo/evidence/task-3-errors-test.log
  ```

  **Commit**: YES
  - Message: `feat(core): add status enums + batch error classes with stable codes`
  - Files: `packages/nest-batch/src/core/status.ts`, `errors.ts`, `tests/core/*.test.ts`

- [x] 4. JobRepository + TransactionManager abstract classes

  **What to do**:
  - Create `packages/nest-batch/src/core/repository/job-repository.ts`:
    - `export abstract class JobRepository { ... }` (Nest DI token)
    - Methods (per ORACLE 2b, aggregate-based low-level):
      - `getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance>`
      - `createJobExecution(jobInstanceId: string, params: JobParameters): Promise<JobExecution>`
      - `updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void>`
      - `getJobExecution(executionId: string): Promise<JobExecution | null>`
      - `createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution>`
      - `updateStepExecution(stepExecutionId: string, patch: StepExecutionPatch): Promise<void>`
      - `getStepExecution(stepExecutionId: string): Promise<StepExecution | null>`
      - `getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext>`
      - `saveExecutionContext(scope: ExecutionScope, ctx: ExecutionContext, version?: number): Promise<void>`
    - Also export `interface JobRepository` (structural mirror) for users who prefer interface DI
  - Create `packages/nest-batch/src/core/transaction/transaction-manager.ts`:
    - `export abstract class TransactionManager { abstract withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> }`
    - `TransactionContext` (placeholder for adapter-specific info)
  - Create value types in `packages/nest-batch/src/core/repository/types.ts`:
    - `JobInstance { id: string; jobName: string; jobKey: string; createdAt: Date; }`
    - `JobExecution { id: string; jobInstanceId: string; status: JobStatus; startTime: Date | null; endTime: Date | null; exitCode: string; exitMessage: string; params: JobParameters; }`
    - `StepExecution { id: string; jobExecutionId: string; stepName: string; status: StepStatus; readCount: number; writeCount: number; skipCount: number; rollbackCount: number; commitCount: number; }`
    - `ExecutionContext { data: JsonValue; version: number; }`
    - `ExecutionScope = { jobExecutionId: string } | { stepExecutionId: string }`
    - `JobParameters: Record<string, JsonValue>`
  - Create `packages/nest-batch/tests/core/repository/contract.test.ts`:
    - Test: abstract class cannot be instantiated directly
    - Test: every method is declared as abstract (compile-time check)
    - Test: `JobRepository` type can be used as Nest provider token in `Test.createTestingModule`

  **Must NOT do**: No in-memory implementation (Task 13), no MikroORM (Task 34). Contract only.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Abstract contract design, careful typing

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 5, 6)
  - **Blocks**: 13, 18, 34, 36, 38
  - **Blocked By**: 2 (IR types)

  **References**:
  - ORACLE verdict 2a: "abstract class + interface 동시 export"
  - ORACLE verdict 2b: "aggregate-based low-level"
  - Spring Batch `JobRepository` interface: docs.spring.io/spring-batch/reference/html/job.html#JobRepository

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test contract` → green
  - [ ] `pnpm exec tsc --noEmit` → 0 errors
  - [ ] `JobRepository` is importable as Nest provider in test module

  **QA Scenarios**:
  ```
  Scenario: Abstract class is non-instantiable
    Tool: Bash (vitest + tsc)
    Steps:
      1. pnpm exec vitest run tests/core/repository/contract.test.ts
    Expected: exit 0, test "cannot instantiate JobRepository" passes
    Evidence: .omo/evidence/task-4-abstract-class-test.log
  ```

  **Commit**: YES
  - Message: `feat(core): add JobRepository and TransactionManager abstract classes (DI contracts)`
  - Files: `packages/nest-batch/src/core/repository/*.ts`, `transaction/*.ts`, `tests/core/repository/*.test.ts`

- [x] 5. ExecutionContext JSON serializer + JsonValue type

  **What to do**:
  - Create `packages/nest-batch/src/core/execution-context/json-value.ts`:
    - `export type JsonPrimitive = string | number | boolean | null;`
    - `export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };`
  - Create `packages/nest-batch/src/core/execution-context/validator.ts`:
    - `export function assertJsonSerializable(value: unknown, path = '$'): void`
    - Throws `InvalidExecutionContextError` with path on first failure
    - Rejects: function, class instance (typeof === 'object' && constructor !== Object && !Array && !Date), circular ref (use WeakSet), BigInt, Symbol, undefined, Stream, EventEmitter, ORM entity manager (`isEntityManager(value)` check via duck-typing on `persist`/`flush` methods)
  - Create `packages/nest-batch/src/core/execution-context/serializer.ts`:
    - `export function serializeContext(ctx: unknown): string` (JSON.stringify, throws on BigInt via replacer)
    - `export function deserializeContext<T extends JsonValue>(raw: string): T` (JSON.parse)
  - Create `packages/nest-batch/tests/core/execution-context/validator.test.ts`:
    - Tests: accepts `{ a: 1, b: 'x', c: [1,2,3], d: { e: null } }`
    - Tests: rejects `() => 1` (function)
    - Tests: rejects circular ref
    - Tests: rejects class instance (e.g., `new Date()` is OK, but custom class is not)
    - Tests: rejects BigInt
    - Tests: rejects `undefined` (must be omitted or null)
  - Create `packages/nest-batch/tests/core/execution-context/serializer.test.ts`:
    - Roundtrip tests for valid JSON values
    - Throws on BigInt

  **Must NOT do**: No actual context storage, no adapter integration.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Edge case-heavy serializer, careful rejection logic

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4, 6)
  - **Blocks**: 13, 18, 34
  - **Blocked By**: None

  **References**:
  - ORACLE verdict 2d: "JSON-serializable + metadata/version"
  - ORACLE risk 7: "serialization contract"
  - Metis risks: "non-JSON-serializable ExecutionContext fails validation with clear error"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test validator` → green
  - [ ] `pnpm --filter @nest-batch/core test serializer` → green
  - [ ] `assertJsonSerializable({fn: () => 1})` throws `InvalidExecutionContextError` with `$.fn`
  - [ ] `assertJsonSerializable(BigInt(1))` throws
  - [ ] `serializeContext` + `deserializeContext` roundtrip preserves value

  **QA Scenarios**:
  ```
  Scenario: Validator rejects non-serializable values
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run tests/core/execution-context/validator.test.ts
    Expected: exit 0, all 6 rejection cases pass
    Evidence: .omo/evidence/task-5-validator-rejections.log

  Scenario: Roundtrip preserves nested data
    Tool: Bash (node REPL via vitest)
    Steps:
      1. pnpm exec vitest run tests/core/execution-context/serializer.test.ts
    Expected: exit 0, 3 roundtrip cases pass
    Evidence: .omo/evidence/task-5-serializer-roundtrip.log
  ```

  **Commit**: YES
  - Message: `feat(core): add JsonValue type + execution context validator + serializer`
  - Files: `packages/nest-batch/src/core/execution-context/*.ts`, `tests/core/execution-context/*.test.ts`

- [x] 6. DefinitionValidator (graph integrity)

  **What to do**:
  - Create `packages/nest-batch/src/core/validation/definition-validator.ts`:
    - `export class DefinitionValidator { validate(job: JobDefinition): void }` (throws on errors)
  - Validation rules (per ORACLE 1b + Metis edge cases):
    - **One start step**: exactly one step is referenced as `startStepId`
    - **All transitions target existing steps**: every `toStepId !== null` must exist in `job.steps`
    - **No unreachable steps**: BFS/DFS from `startStepId` following transitions, all steps must be reachable
    - **No cycles unless explicitly allowed**: detect cycles in transition graph (default: reject)
    - **At least one step**: `Object.keys(job.steps).length > 0`
    - **Step names unique**: no duplicate step IDs
    - **Listener contracts**: if `chunk` step has `processor`, OK; if `tasklet` step, no `reader`/`writer` allowed
  - Create `packages/nest-batch/tests/core/validation/definition-validator.test.ts`:
    - Test: valid job (1 tasklet, 1 chunk) passes
    - Test: missing transition target throws `InvalidFlowGraphError` with code `MISSING_TARGET`
    - Test: no start step throws `NO_START_STEP`
    - Test: unreachable step throws `UNREACHABLE_STEP`
    - Test: cycle throws `CYCLE_DETECTED`
    - Test: empty steps throws
    - Test: duplicate step IDs throws
    - Test: tasklet step with reader throws
    - Test: cycle with explicit `allowCycles: true` (job-level flag) passes

  **Must NOT do**: No Nest integration, no runtime execution. Pure validation.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Graph algorithm (DFS/BFS) + careful error messaging

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4, 5)
  - **Blocks**: 9 (JobRegistry)
  - **Blocked By**: 2 (IR types), 3 (errors)

  **References**:
  - ORACLE verdict 1b: "validator enforces all transitions target existing steps, one start step, no accidental cycles, terminal statuses are handled"
  - Metis: "Invalid flow graph fails validation: missing step target, unreachable step, cycle if cycles are disallowed, ambiguous transition"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test definition-validator` → green
  - [ ] All 8 negative tests pass
  - [ ] Valid job (single tasklet) passes
  - [ ] Error messages include step name when applicable

  **QA Scenarios**:
  ```
  Scenario: Cycle in transition graph is detected
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run tests/core/validation/definition-validator.test.ts
    Expected: exit 0, "cycle detected" test passes with InvalidFlowGraphError code CYCLE_DETECTED
    Evidence: .omo/evidence/task-6-cycle-detection.log

  Scenario: Unreachable step is detected
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run tests/core/validation/definition-validator.test.ts -t "unreachable"
    Expected: exit 0, "unreachable step" test passes with code UNREACHABLE_STEP
    Evidence: .omo/evidence/task-6-unreachable-step.log
  ```

  **Commit**: YES
  - Message: `feat(core): add DefinitionValidator for IR graph integrity`
  - Files: `packages/nest-batch/src/core/validation/*.ts`, `tests/core/validation/*.test.ts`

### Wave 2 — M1: REGISTRY + DECORATOR API (depends: Wave 1)

**Sub-wave structure** (corrected from initial single-wave claim to reflect internal dependencies):
- **Wave 2a** (immediate, independent): Tasks 10, 11 (pure decorator metadata) + Task 13 (InMemoryJobRepository, depends only on Wave 1 contracts)
- **Wave 2b** (after 2a): Tasks 7, 8, 9, 12 (consume decorator metadata, wire to registry/module)

#### Wave 2a — Decorators + InMemory Repository (3 tasks, all independent)

- [x] 10. Decorator API: @Jobable, @Stepable, @Tasklet

  **What to do**:
  - Create `packages/nest-batch/src/decorators/job.decorator.ts`:
    - `export function Jobable(options: { id: string; restartable?: boolean; allowDuplicateInstances?: boolean }): ClassDecorator`
    - Uses `SetMetadata(BATCH_JOB_METADATA, options)`
  - Create `packages/nest-batch/src/decorators/step.decorator.ts`:
    - `export function Stepable(options: { id: string; chunkSize?: number }): MethodDecorator` (chunkSize = 0 means tasklet)
  - Create `packages/nest-batch/src/decorators/tasklet.decorator.ts`:
    - `export function Tasklet(): MethodDecorator` (marks a method as the tasklet handler for a `@Stepable` step; alternative to chunk)
  - Create `packages/nest-batch/src/decorators/index.ts` (re-exports)
  - Create `packages/nest-batch/tests/decorators/job-step-tasklet.decorator.test.ts`:
    - Test (happy): `@Jobable({ id: 'foo' })` sets correct metadata on class
    - Test (happy): `@Stepable({ id: 'bar' })` sets correct metadata on method
    - Test (happy): `@Stepable({ id: 'bar' }) @Tasklet()` combination (tasklet step)
    - Test (failure): `Reflect.getMetadata(BATCH_JOB_METADATA, klass)` returns options

  **Must NOT do**: No compiler logic, no runtime behavior. Metadata only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Pure decorator + metadata

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a (with Tasks 11, 13)
  - **Blocks**: 7, 8 (via metadata keys)
  - **Blocked By**: None (pure metadata)

  **References**:
  - @nestjs/cqrs `@CommandHandler`: `https://github.com/nestjs/cqrs/blob/master/src/decorators/command-handler.decorator.ts`
  - @nestjs/schedule `@Cron`: `https://github.com/nestjs/schedule/blob/master/lib/decorators/cron.decorator.ts`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-step-tasklet` → green (4 tests, including failure case)
  - [ ] All 4 metadata tests pass
  - [ ] Decorators are importable as named exports

  **QA Scenarios**:
  ```
  Scenario: @Jobable attaches correct metadata (happy)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/job-step-tasklet.decorator.test.ts -t "metadata"
    Expected: exit 0
    Evidence: .omo/evidence/task-10-decorator-metadata.log

  Scenario: Missing metadata returns undefined (failure)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/job-step-tasklet.decorator.test.ts -t "missing"
    Expected: exit 0, returns undefined
    Evidence: .omo/evidence/task-10-missing-metadata.log
  ```

  **Commit**: YES
  - Message: `feat(decorators): add @Jobable, @Stepable, @Tasklet`
  - Files: `packages/nest-batch/src/decorators/{job,step,tasklet}.decorator.ts`, `index.ts`, `tests/decorators/*.test.ts`

- [x] 11. Decorator API: @ItemReader, @ItemProcessor, @ItemWriter + 7 listener decorators

  **What to do**:
  - Create `packages/nest-batch/src/decorators/item.decorators.ts`:
    - `@ItemReader()` — MethodDecorator, metadata key `BATCH_ITEM_READER_METADATA`, returns `Promise<unknown> | AsyncIterable<unknown> | null`
    - `@ItemProcessor()` — MethodDecorator, key `BATCH_ITEM_PROCESSOR_METADATA`, returns `Promise<unknown>` (return null/undefined to filter)
    - `@ItemWriter()` — MethodDecorator, key `BATCH_ITEM_WRITER_METADATA`, returns `Promise<void>`, takes array of items
  - Create `packages/nest-batch/src/decorators/listener.decorators.ts`:
    - `@BeforeJob()` / `@AfterJob()` — MethodDecorator
    - `@BeforeStep()` / `@AfterStep()`
    - `@BeforeChunk()` / `@AfterChunk()` / `@OnChunkError()`
    - `@BeforeRead()` / `@AfterRead()` / `@OnReadError()`
    - `@BeforeProcess()` / `@AfterProcess()` / `@OnProcessError()`
    - `@BeforeWrite()` / `@AfterWrite()` / `@OnWriteError()`
    - `@OnSkipRead()` / `@OnSkipProcess()` / `@OnSkipWrite()`
    - All set listener metadata with kind + phase
  - Create `packages/nest-batch/tests/decorators/item-and-listeners.decorator.test.ts`:
    - Test (happy): each decorator sets expected metadata key
    - Test (happy): 7 listener kinds each have correct phase labels (before/after/on-error)
    - Test (failure): applying `@ItemReader` to a non-method throws TypeError at class definition

  **Must NOT do**: No listener invoker logic (Task 20), no execution.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Repetitive decorator pattern, low risk

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a (with Tasks 10, 13)
  - **Blocks**: 7, 8, 20
  - **Blocked By**: None (pure metadata)

  **References**:
  - Spring Batch 7 listener types: docs.spring.io/spring-batch/reference/html/listeners.html
  - Metis: "7 Listeners (Job/Step/Chunk/ItemRead/ItemProcess/ItemWrite/Skip) — decorator + builder 등록"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test item-and-listeners` → green
    - [ ] 3 item decorators + 17 listener decorators all set metadata correctly
    - [ ] Total 20+ decorator tests pass (includes 1 failure case)

  **QA Scenarios**:
  ```
  Scenario: All 7 listener decorator kinds set correct metadata (happy)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/item-and-listeners.decorator.test.ts -t "metadata"
    Expected: exit 0, 20 tests pass
    Evidence: .omo/evidence/task-11-listener-decorators.log

  Scenario: Decorator on non-method is detected (failure)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/item-and-listeners.decorator.test.ts -t "non-method"
    Expected: exit 0, throws TypeError
    Evidence: .omo/evidence/task-11-decorator-misuse.log
  ```

  **Commit**: YES
  - Message: `feat(decorators): add @ItemReader/Processor/Writer + 17 listener decorators (7 kinds)`
  - Files: `packages/nest-batch/src/decorators/{item,listener}.decorators.ts`, `tests/decorators/item-and-listeners.decorator.test.ts`

- [x] 13. InMemoryJobRepository (real repo, not fake)

  **What to do**:
  - Create `packages/nest-batch/src/repository/in-memory/in-memory-job-repository.ts`:
    - `export class InMemoryJobRepository extends JobRepository`
    - Private state: `Map<string, JobInstance>`, `Map<string, JobExecution>`, `Map<string, StepExecution>`, `Map<ExecutionScope, ExecutionContext>`
    - Inject `IdGenerator` interface (default: `crypto.randomUUID()`, deterministic variant for tests)
  - Implement all abstract methods:
    - `getOrCreateJobInstance`: atomically check `(name, jobKey)` exists; if not, create with new ID. Use async lock (simple promise chain) to prevent race
    - `createJobExecution`, `updateJobExecution`, `getJobExecution`
    - `createStepExecution`, `updateStepExecution`, `getStepExecution`
    - `getExecutionContext`: returns `ExecutionContext { data: null, version: 0 }` if not exists
    - `saveExecutionContext`: deep-clone input data before storing; throw `InvalidExecutionContextError` from validator if non-serializable; version increments if `version` arg present
  - Export `IdGenerator` interface + `UuidIdGenerator` (default) + `DeterministicIdGenerator` (test)
  - Mark `restartable: false` as default (per Metis directive "in-memory repo는 non-restartable 기본")
  - Create `packages/nest-batch/tests/repository/in-memory-job-repository.test.ts`:
    - Test (happy): `getOrCreateJobInstance` returns same instance for same `(name, key)` (call 1: create, call 2: get)
    - Test (happy): deep clone: `updateStepExecution({id, readCount: 1})` then `getStepExecution(id)` returns independent object
    - Test (failure): concurrent `getOrCreateJobInstance` calls (Promise.all) result in 1 instance
    - Test (failure): `saveExecutionContext` with function value throws `InvalidExecutionContextError`
    - Test (failure): `saveExecutionContext` with circular ref throws
    - Test (happy): deterministic IDs (with `DeterministicIdGenerator`) produce predictable output

  **Must NOT do**: No MikroORM (Task 34), no on-disk persistence.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Concurrency edge cases, deep clone correctness, async lock

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a (with Tasks 10, 11)
  - **Blocks**: 15, 18, 19, 40 (smoke test)
  - **Blocked By**: 4 (abstract class), 5 (validator)

  **References**:
  - ORACLE verdict 2c: "진짜 repository처럼 행동 — deterministic IDs, deep-clone reads/writes, async signatures, uniqueness, 동시 launch 시 race condition 재현 가능"
  - Metis: "in-memory repo는 non-restartable 기본"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test in-memory-job-repository` → green
    - [ ] 3 happy + 3 failure test cases pass (total 6)
    - [ ] All async signatures honored

  **QA Scenarios**:
  ```
  Scenario: Concurrent getOrCreateJobInstance produces 1 instance (concurrency edge case)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/repository/in-memory-job-repository.test.ts -t "concurrent"
    Expected: exit 0, Promise.all of 10 calls yields 1 instance
    Evidence: .omo/evidence/task-13-concurrent-uniqueness.log

  Scenario: Non-serializable ExecutionContext rejected (failure)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/repository/in-memory-job-repository.test.ts -t "non-serializable"
    Expected: exit 0, throws InvalidExecutionContextError
    Evidence: .omo/evidence/task-13-invalid-context.log

  Scenario: Deep clone prevents mutation leak (happy)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/repository/in-memory-job-repository.test.ts -t "deep clone"
    Expected: exit 0, mutating returned object does not affect stored
    Evidence: .omo/evidence/task-13-deep-clone.log
  ```

  **Commit**: YES
  - Message: `feat(repository): add InMemoryJobRepository with real repo semantics (deterministic IDs, deep clone, uniqueness)`
  - Files: `packages/nest-batch/src/repository/in-memory/*.ts`, `tests/repository/*.test.ts`

- [x] 8. DefinitionCompiler (metadata/builder → IR)

  **What to do**:
  - Create `packages/nest-batch/src/compiler/definition-compiler.ts`:
    - `export class DefinitionCompiler`
    - `compileFromDiscovered(discovered: DiscoveredJob, providers: Map<string, any>): JobDefinition`
    - `compileFromBuilderConfig(config: JobBuilderConfig): JobDefinition`
    - Both methods produce the same `JobDefinition` shape (parity contract)
  - Logic:
    - Resolve `ReaderRef`/`WriterRef`/`ProcessorRef`/`TaskletRef`/`ListenerRef`:
      - `'provider-token'`: lookup in `providers` map
      - `'method'`: lookup class instance, then bind method
    - Build step definitions from each `@Stepable` method
    - Build listener definitions from each `@OnBeforeJob`/`@OnAfterJob`/etc decorator
    - Validate ID uniqueness within job
  - Create `packages/nest-batch/src/compiler/builder-types.ts`:
    - Export types for `JobBuilderConfig`, `StepBuilderConfig`, `ChunkStepConfig`, `TaskletStepConfig` (used by Builder API in Task 14)
  - Create `packages/nest-batch/tests/compiler/definition-compiler.test.ts`:
    - Test: compile from discovered `@Jobable` class with 1 step + 1 listener → valid IR
    - Test: compile from builder config with same structure → valid IR
    - Test: **PARITY TEST** — same logical job via both APIs produces structurally equal IR (deep-equal, ignoring function refs by stable ID)
    - Test: missing provider token throws `BatchError` with code `PROVIDER_NOT_FOUND`

  **Must NOT do**: No execution, no registry. Pure transformation.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Parity contract is critical, careful ref resolution

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 9, 10, 11, 12, 13)
  - **Blocks**: 9
  - **Blocked By**: 2, 7, 10, 11

  **References**:
  - ORACLE verdict 1a: "decorators and builders must both compile to JobDefinition before execution"
  - Metis: "Decorator ↔ Builder parity test 필수 (같은 JobDefinition으로 컴파일되는지)"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test definition-compiler` → green
  - [ ] Parity test passes: same job via decorator and builder produces deep-equal IR (excluding function bodies, compared by ID)
  - [ ] Missing provider token test passes

  **QA Scenarios**:
  ```
  Scenario: Parity test - decorator and builder produce same IR
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/compiler/definition-compiler.test.ts -t "parity"
    Expected: exit 0, deep equality holds
    Evidence: .omo/evidence/task-8-parity-test.log
  ```

  **Commit**: YES
  - Message: `feat(compiler): add DefinitionCompiler (metadata/builder → IR, parity contract)`
  - Files: `packages/nest-batch/src/compiler/*.ts`, `tests/compiler/*.test.ts`

- [x] 9. JobRegistry (validated definitions storage)

  **What to do**:
  - Create `packages/nest-batch/src/registry/job-registry.ts`:
    - `@Injectable() export class JobRegistry`
    - Private `Map<string, JobDefinition>` storing validated definitions
    - `register(job: JobDefinition): void` — validates via `DefinitionValidator`, throws `DuplicateJobDefinitionError` if `job.id` exists
    - `get(jobId: string): JobDefinition` — throws `JobNotFoundError` if missing
    - `has(jobId: string): boolean`
    - `getAll(): JobDefinition[]` (for debugging/admin — not exposed via REST in MVP)
  - Create `packages/nest-batch/tests/registry/job-registry.test.ts`:
    - Test: register + get returns same definition
    - Test: duplicate `job.id` throws `DuplicateJobDefinitionError`
    - Test: invalid graph (cycle) throws `InvalidFlowGraphError`
    - Test: `get` for missing job throws `JobNotFoundError`

  **Must NOT do**: No module init wiring (Task 12), no execution. Storage + validation only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Thin wrapper around Map + validator

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 10, 11, 12, 13)
  - **Blocks**: 12, 19 (JobLauncher)
  - **Blocked By**: 6, 8

  **References**:
  - ORACLE verdict 1c: "JobRegistry stores definitions by job name"
  - @nestjs/schedule `SchedulerRegistry`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-registry` → green
  - [ ] All 4 test cases pass
  - [ ] Validator is invoked on every `register` call

  **QA Scenarios**:
  ```
  Scenario: Duplicate job registration is rejected
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/registry/job-registry.test.ts -t "duplicate"
    Expected: exit 0, throws DuplicateJobDefinitionError
    Evidence: .omo/evidence/task-9-duplicate-rejection.log
  ```

  **Commit**: YES
  - Message: `feat(registry): add JobRegistry with validation on register`
  - Files: `packages/nest-batch/src/registry/*.ts`, `tests/registry/*.test.ts`

- [x] 10. Decorator API: @Jobable, @Stepable, @Tasklet

  **What to do**:
  - Create `packages/nest-batch/src/decorators/job.decorator.ts`:
    - `export function Jobable(options: { id: string; restartable?: boolean; allowDuplicateInstances?: boolean }): ClassDecorator`
    - Uses `SetMetadata(BATCH_JOB_METADATA, options)`
  - Create `packages/nest-batch/src/decorators/step.decorator.ts`:
    - `export function Stepable(options: { id: string; chunkSize?: number }): MethodDecorator` (chunkSize = 0 means tasklet)
  - Create `packages/nest-batch/src/decorators/tasklet.decorator.ts`:
    - `export function Tasklet(): MethodDecorator` (marks a method as the tasklet handler for a `@Stepable` step; alternative to chunk)
  - Create `packages/nest-batch/src/decorators/index.ts` (re-exports)
  - Create `packages/nest-batch/tests/decorators/job-step-tasklet.decorator.test.ts`:
    - Test: `@Jobable({ id: 'foo' })` sets correct metadata on class
    - Test: `@Stepable({ id: 'bar' })` sets correct metadata on method
    - Test: `@Stepable({ id: 'bar' }) @Tasklet()` combination (tasklet step)
    - Test: `Reflect.getMetadata(BATCH_JOB_METADATA, klass)` returns options

  **Must NOT do**: No compiler logic, no runtime behavior. Metadata only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Pure decorator + metadata

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 11, 12, 13)
  - **Blocks**: 7, 8
  - **Blocked By**: None (pure metadata)

  **References**:
  - @nestjs/cqrs `@CommandHandler`: `https://github.com/nestjs/cqrs/blob/master/src/decorators/command-handler.decorator.ts`
  - @nestjs/schedule `@Cron`: `https://github.com/nestjs/schedule/blob/master/lib/decorators/cron.decorator.ts`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-step-tasklet` → green
  - [ ] All 4 metadata tests pass
  - [ ] Decorators are importable as named exports

  **QA Scenarios**:
  ```
  Scenario: @Jobable attaches correct metadata
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/job-step-tasklet.decorator.test.ts
    Expected: exit 0, all tests pass
    Evidence: .omo/evidence/task-10-decorator-metadata.log
  ```

  **Commit**: YES
  - Message: `feat(decorators): add @Jobable, @Stepable, @Tasklet`
  - Files: `packages/nest-batch/src/decorators/{job,step,tasklet}.decorator.ts`, `index.ts`, `tests/decorators/*.test.ts`

- [x] 11. Decorator API: @ItemReader, @ItemProcessor, @ItemWriter + 7 listener decorators

  **What to do**:
  - Create `packages/nest-batch/src/decorators/item.decorators.ts`:
    - `@ItemReader()` — MethodDecorator, metadata key `BATCH_ITEM_READER_METADATA`, returns `Promise<unknown> | AsyncIterable<unknown> | null`
    - `@ItemProcessor()` — MethodDecorator, key `BATCH_ITEM_PROCESSOR_METADATA`, returns `Promise<unknown>` (return null/undefined to filter)
    - `@ItemWriter()` — MethodDecorator, key `BATCH_ITEM_WRITER_METADATA`, returns `Promise<void>`, takes array of items
  - Create `packages/nest-batch/src/decorators/listener.decorators.ts`:
    - `@BeforeJob()` / `@AfterJob()` — MethodDecorator
    - `@BeforeStep()` / `@AfterStep()`
    - `@BeforeChunk()` / `@AfterChunk()` / `@OnChunkError()`
    - `@BeforeRead()` / `@AfterRead()` / `@OnReadError()`
    - `@BeforeProcess()` / `@AfterProcess()` / `@OnProcessError()`
    - `@BeforeWrite()` / `@AfterWrite()` / `@OnWriteError()`
    - `@OnSkipRead()` / `@OnSkipProcess()` / `@OnSkipWrite()`
    - All set listener metadata with kind + phase
  - Create `packages/nest-batch/tests/decorators/item-and-listeners.decorator.test.ts`:
    - Test: each decorator sets expected metadata key
    - Test: 7 listener kinds each have correct phase labels (before/after/on-error)

  **Must NOT do**: No listener invoker logic (Task 20), no execution.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Repetitive decorator pattern, low risk

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 10, 12, 13)
  - **Blocks**: 7, 8, 20
  - **Blocked By**: None (pure metadata)

  **References**:
  - Spring Batch 7 listener types: docs.spring.io/spring-batch/reference/html/listeners.html
  - Metis: "7 Listeners (Job/Step/Chunk/ItemRead/ItemProcess/ItemWrite/Skip) — decorator + builder 등록"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test item-and-listeners` → green
    - [ ] 3 item decorators + 17 listener decorators all set metadata correctly
    - [ ] Total 20 decorator tests pass

  **QA Scenarios**:
  ```
  Scenario: All 7 listener decorator kinds set correct metadata
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/item-and-listeners.decorator.test.ts
    Expected: exit 0, 20 tests pass
    Evidence: .omo/evidence/task-11-listener-decorators.log
  ```

  **Commit**: YES
  - Message: `feat(decorators): add @ItemReader/Processor/Writer + 17 listener decorators (7 kinds)`
  - Files: `packages/nest-batch/src/decorators/{item,listener}.decorators.ts`, `tests/decorators/item-and-listeners.decorator.test.ts`

- [x] 12. NestBatchModule (forRoot, forRootAsync, Explorer wiring)

  **What to do**:
  - Create `packages/nest-batch/src/module/nest-batch.module.ts`:
    - `@Module({}) export class NestBatchModule`
    - Static `forRoot(options?: { explorer?: boolean }): DynamicModule` — registers `BatchExplorer`, `DefinitionCompiler`, `JobRegistry`, providers, and exports `JobRegistry` + `JobLauncher` (Task 19)
    - Static `forRootAsync(options: { imports; useFactory; inject }): DynamicModule` — async config
  - Wire `BatchExplorer.onModuleInit` to call `DefinitionCompiler.compileFromDiscovered` + `JobRegistry.register`
  - Export all public types/classes from `packages/nest-batch/src/index.ts`
  - Create `packages/nest-batch/tests/module/nest-batch.module.spec.ts`:
    - Test: `Test.createTestingModule({ imports: [NestBatchModule.forRoot()] })` boots
    - Test: `JobRegistry` is injectable
    - Test: `BatchExplorer.onModuleInit` discovers + registers a test `@Jobable` class

  **Must NOT do**: No actual job execution in this task. Wiring only.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Nest module wiring, async config edge cases

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 7, 8, 9, 10, 11, 13)
  - **Parallel Group**: Wave 2
  - **Blocks**: 19 (JobLauncher needs module context)
  - **Blocked By**: 7, 8, 9, 19 (forward reference to JobLauncher — use lazy import or Task 19 stub)

  **References**:
  - @nestjs/cqrs `CqrsModule` source: `https://github.com/nestjs/cqrs/blob/master/src/cqrs.module.ts`
  - @nestjs/schedule `ScheduleModule.forRoot` source

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test nest-batch.module` → green
    - [ ] `forRoot()` module boots
    - [ ] `forRootAsync()` module boots with mock factory
    - [ ] Explorer wired correctly to registry
    - [ ] `JobRegistry` injectable from outside module

  **QA Scenarios**:
  ```
  Scenario: forRoot module boots and explorer registers test job
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/module/nest-batch.module.spec.ts
    Expected: exit 0, 3 tests pass
    Evidence: .omo/evidence/task-12-module-boot.log
  ```

  **Commit**: YES
  - Message: `feat(module): add NestBatchModule.forRoot + forRootAsync with explorer wiring`
  - Files: `packages/nest-batch/src/module/*.ts`, `src/index.ts`, `tests/module/*.spec.ts`

- [x] 13. InMemoryJobRepository (real repo, not fake)

  **What to do**:
  - Create `packages/nest-batch/src/repository/in-memory/in-memory-job-repository.ts`:
    - `export class InMemoryJobRepository extends JobRepository`
    - Private state: `Map<string, JobInstance>`, `Map<string, JobExecution>`, `Map<string, StepExecution>`, `Map<ExecutionScope, ExecutionContext>`
    - Inject `IdGenerator` interface (default: `crypto.randomUUID()`, deterministic variant for tests)
  - Implement all abstract methods:
    - `getOrCreateJobInstance`: atomically check `(name, jobKey)` exists; if not, create with new ID. Use async lock (simple promise chain) to prevent race
    - `createJobExecution`, `updateJobExecution`, `getJobExecution`
    - `createStepExecution`, `updateStepExecution`, `getStepExecution`
    - `getExecutionContext`: returns `ExecutionContext { data: null, version: 0 }` if not exists
    - `saveExecutionContext`: deep-clone input data before storing; throw `InvalidExecutionContextError` from validator if non-serializable; version increments if `version` arg present
  - Export `IdGenerator` interface + `UuidIdGenerator` (default) + `DeterministicIdGenerator` (test)
  - Mark `restartable: false` as default (per Metis directive "in-memory repo는 non-restartable 기본")
  - Create `packages/nest-batch/tests/repository/in-memory-job-repository.test.ts`:
    - Test: `getOrCreateJobInstance` returns same instance for same `(name, key)` (call 1: create, call 2: get)
    - Test: deep clone: `updateStepExecution({id, readCount: 1})` then `getStepExecution(id)` returns independent object
    - Test: concurrent `getOrCreateJobInstance` calls (Promise.all) result in 1 instance
    - Test: `saveExecutionContext` with function value throws `InvalidExecutionContextError`
    - Test: `saveExecutionContext` with circular ref throws
    - Test: deterministic IDs (with `DeterministicIdGenerator`) produce predictable output

  **Must NOT do**: No MikroORM (Task 34), no on-disk persistence.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Concurrency edge cases, deep clone correctness, async lock

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 10, 11, 12)
  - **Blocks**: 15, 18, 19, 40 (smoke test)
  - **Blocked By**: 4 (abstract class), 5 (validator)

  **References**:
  - ORACLE verdict 2c: "진짜 repository처럼 행동 — deterministic IDs, deep-clone reads/writes, async signatures, uniqueness, 동시 launch 시 race condition 재현 가능"
  - Metis: "in-memory repo는 non-restartable 기본"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test in-memory-job-repository` → green
    - [ ] Uniqueness, deep clone, concurrency, validation, deterministic IDs tests all pass
    - [ ] All 6 test cases pass

  **QA Scenarios**:
  ```
  Scenario: Concurrent getOrCreateJobInstance produces 1 instance
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/repository/in-memory-job-repository.test.ts -t "concurrent"
    Expected: exit 0, Promise.all of 10 calls yields 1 instance
    Evidence: .omo/evidence/task-13-concurrent-uniqueness.log

  Scenario: Deep clone prevents mutation leak
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/repository/in-memory-job-repository.test.ts -t "deep clone"
    Expected: exit 0, mutating returned object does not affect stored
    Evidence: .omo/evidence/task-13-deep-clone.log
  ```

  **Commit**: YES
  - Message: `feat(repository): add InMemoryJobRepository with real repo semantics (deterministic IDs, deep clone, uniqueness)`
  - Files: `packages/nest-batch/src/repository/in-memory/*.ts`, `tests/repository/*.test.ts`

### Wave 3 — M1: BUILDER + EXECUTION ENGINE (depends: Wave 2)

- [x] 14. Builder API: BatchBuilder, JobBuilder, StepBuilder, FlowBuilder

  **What to do**:
  - Create `packages/nest-batch/src/builder/batch-builder.ts`:
    - `export class BatchBuilder { static create(): BatchBuilder; job(id: string, config: JobConfig): BatchBuilder; build(): JobDefinition }`
  - Create `packages/nest-batch/src/builder/job-builder.ts`:
    - `export class JobBuilder { restartable(b: boolean): JobBuilder; allowDuplicateInstances(b: boolean): JobBuilder; addStep(step: StepDefinition | ((b: StepBuilder) => StepBuilder)): JobBuilder; on(status: FlowExecutionStatus): TransitionBuilder; from(stepId: string): TransitionBuilder; end(): JobBuilder; listeners(...): JobBuilder; build(): JobDefinition }`
  - Create `packages/nest-batch/src/builder/step-builder.ts`:
    - `export class StepBuilder { chunk(size: number, config: ChunkConfig): JobBuilder; tasklet(handler: TaskletRef): JobBuilder; chunkSize: number; reader, processor, writer, listeners, skipPolicy, retryPolicy }`
  - Create `packages/nest-batch/src/builder/flow-builder.ts`:
    - `export class TransitionBuilder { to(stepId: string): JobBuilder; end(): JobBuilder }`
  - All methods return `this` or appropriate builder for chaining
  - `build()` invokes `DefinitionValidator` and returns validated `JobDefinition`
  - Create `packages/nest-batch/tests/builder/builder-api.test.ts`:
    - Test: simple 1-step job builder chain
    - Test: 2-step job with chunk step + tasklet step
    - Test: flow transition `.on(FlowExecutionStatus.FAILED).to('recoveryStep')`
    - Test: `.end()` produces `toStepId: null`
    - Test: invalid (cycle) build throws `InvalidFlowGraphError`
    - Test: builder parity — same structure as decorator API produces same IR (uses DefinitionCompiler)

  **Must NOT do**: No execution. Pure configuration → IR.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Complex chained API, type-safe builder, parity contract

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 15, 16, 17, 18, 19, 20)
  - **Parallel Group**: Wave 3
  - **Blocks**: 40, 45
  - **Blocked By**: 2, 6

  **References**:
  - little-yellow-bean/nest-batch `JobBuilder` pattern: `https://github.com/little-yellow-bean/nest-batch`
  - Metis: "둘 다 제공: 데코레이터 API + Builder API (동일 IR)"
  - ORACLE: "Builder API should bypass metadata and emit the same IR directly"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test builder-api` → green
    - [ ] 6 test cases pass
    - [ ] Chaining works (returns correct type at each step)
    - [ ] Parity with decorator API verified

  **QA Scenarios**:
  ```
  Scenario: Builder creates a job with 2 steps and a flow
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/builder/builder-api.test.ts
    Expected: exit 0, all tests pass, built IR has 2 steps + 0 explicit transitions (linear)
    Evidence: .omo/evidence/task-14-builder-api.log
  ```

  **Commit**: YES
  - Message: `feat(builder): add fluent BatchBuilder/JobBuilder/StepBuilder/FlowBuilder with parity to decorator API`
  - Files: `packages/nest-batch/src/builder/*.ts`, `tests/builder/*.test.ts`

- [x] 15. InMemoryTransactionManager (no-op, deep-clone TX context)

  **What to do**:
  - Create `packages/nest-batch/src/transaction/in-memory-transaction-manager.ts`:
    - `export class InMemoryTransactionManager extends TransactionManager`
    - `async withTransaction<T>(fn: (ctx: InMemoryTransactionContext) => Promise<T>): Promise<T>`
    - `InMemoryTransactionContext` = `{ id: string; isActive: true }` (placeholder)
    - No-op implementation: just call `fn(ctx)` and return
  - Create `packages/nest-batch/tests/transaction/in-memory-transaction-manager.test.ts`:
    - Test: function called with valid context
    - Test: function throws → `withTransaction` propagates throw
    - Test: nested `withTransaction` works (no rollback, since no-op)

  **Must NOT do**: No real DB integration.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Trivial no-op implementation

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 14, 16, 17, 18, 19, 20)
  - **Blocks**: 18, 19
  - **Blocked By**: 4

  **References**:
  - ORACLE verdict 3a: "Ship a no-op implementation for in-memory/demo-light use"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test in-memory-transaction-manager` → green
    - [ ] 3 test cases pass

  **QA Scenarios**:
  ```
  Scenario: withTransaction calls function with context
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/transaction/in-memory-transaction-manager.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-15-tx-noop.log
  ```

  **Commit**: YES
  - Message: `feat(transaction): add InMemoryTransactionManager (no-op reference implementation)`
  - Files: `packages/nest-batch/src/transaction/in-memory-*.ts`, `tests/transaction/*.test.ts`

- [x] 16. ItemReader/ItemProcessor/ItemWriter interfaces

  **What to do**:
  - Create `packages/nest-batch/src/core/item/interfaces.ts`:
    - `export interface ItemReader<T> { read(): Promise<T | null> /* null = EOF */ }`
    - `export interface ItemProcessor<I, O> { process(item: I): Promise<O | null> /* null = filter */ }`
    - `export interface ItemWriter<T> { write(items: T[]): Promise<void> }`
    - `export interface Tasklet { execute(ctx: TaskletContext): Promise<unknown> }`
    - `export interface TaskletContext { jobExecutionId: string; stepExecutionId: string; getExecutionContext(): Promise<ExecutionContext>; saveExecutionContext(ctx: ExecutionContext): Promise<void> }`
  - Create `packages/nest-batch/src/core/item/index.ts` (re-exports)
  - Create `packages/nest-batch/tests/core/item/interfaces.test.ts`:
    - Test: each interface can be implemented with a simple class
    - Test: `null` from read() is interpreted as EOF
    - Test: `null` from process() is interpreted as filter

  **Must NOT do**: No execution logic. Interface only.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Interface definitions

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 17, 18, 42, 43, 44
  - **Blocked By**: None

  **References**:
  - Spring Batch `ItemReader`, `ItemProcessor`, `ItemWriter`, `Tasklet` interfaces

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test interfaces` → green
    - [ ] 3 test cases pass

  **QA Scenarios**:
  ```
  Scenario: null read() is EOF
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/core/item/interfaces.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-16-item-interfaces.log
  ```

  **Commit**: YES
  - Message: `feat(core): add ItemReader/ItemProcessor/ItemWriter/Tasklet interfaces`
  - Files: `packages/nest-batch/src/core/item/*.ts`, `tests/core/item/*.test.ts`

- [x] 17. TaskletStepExecutor

  **What to do**:
  - Create `packages/nest-batch/src/execution/tasklet-step-executor.ts`:
    - `export class TaskletStepExecutor`
    - `async execute(step: TaskletStepDefinition, context: StepExecutionContext): Promise<StepExecutionResult>`
    - `StepExecutionContext = { jobExecutionId: string; transactionManager: TransactionManager; jobRepository: JobRepository; listeners: ListenerInvoker; }`
    - `StepExecutionResult = { status: StepStatus; exitCode: string; exitMessage: string; readCount: 0; writeCount: 0; skipCount: 0; }`
  - Logic:
    1. Call `beforeStep` listeners
    2. `await transactionManager.withTransaction(async (txCtx) => { ... })` (wraps the tasklet.execute)
    3. Call `tasklet.execute(taskletContext)` (which uses `getExecutionContext`/`saveExecutionContext`)
    4. If tasklet throws → call `onError` listeners, mark step FAILED
    5. Call `afterStep` listeners (passing status)
  - Create `packages/nest-batch/tests/execution/tasklet-step-executor.test.ts`:
    - Test: simple tasklet that returns "DONE" → status COMPLETED
    - Test: tasklet that throws → status FAILED, exitMessage contains error
    - Test: before/after listeners invoked in correct order
    - Test: withTransaction wraps the tasklet call

  **Must NOT do**: No chunk processing (Task 18), no policy application (Task 21-23).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Listener orchestration, TX wrap, error handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 19, 20
  - **Blocked By**: 15, 16, 13 (in-memory repo for context)

  **References**:
  - ORACLE verdict 3a: "Chunk execution should call withTransaction around process/write/repository-context update when configured"
  - Spring Batch `TaskletStep` source

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test tasklet-step-executor` → green
    - [ ] 4 test cases pass

  **QA Scenarios**:
  ```
  Scenario: Tasklet success path with TX wrap
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/tasklet-step-executor.test.ts
    Expected: exit 0, status COMPLETED
    Evidence: .omo/evidence/task-17-tasklet-success.log

  Scenario: Tasklet throw propagates as FAILED
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/tasklet-step-executor.test.ts -t "throws"
    Expected: exit 0, status FAILED
    Evidence: .omo/evidence/task-17-tasklet-failed.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add TaskletStepExecutor with TX wrap + listener orchestration`
  - Files: `packages/nest-batch/src/execution/tasklet-step-executor.ts`, `tests/execution/*.test.ts`

- [x] 18. ChunkStepExecutor (reader → process → write loop, no policies yet)

  **What to do**:
  - Create `packages/nest-batch/src/execution/chunk-step-executor.ts`:
    - `export class ChunkStepExecutor`
    - `async execute(step: ChunkStepDefinition, context: StepExecutionContext): Promise<StepExecutionResult>`
  - Logic (NO skip/retry yet — that's Task 23):
    ```
    for each chunk of up to chunkSize items:
      1. Read N items: items = []
         loop:
           item = await reader.read()
           if item is null: break
           items.push(item)
         if items is empty: break (EOF)
      2. Process items: processed = []
         for each item:
           result = await processor.process(item)
           if result is not null: processed.push(result)
      3. Write chunk: await writer.write(processed)
      4. commitCount += 1
      5. readCount += items.length
      6. writeCount += processed.length
    ```
  - After all chunks: status COMPLETED
  - On error: status FAILED, exitMessage contains error
  - NO skip/retry logic — that's added in Task 23
  - Create `packages/nest-batch/tests/execution/chunk-step-executor.test.ts`:
    - Test: 5 items, chunkSize=2 → 3 chunks (2+2+1), readCount=5, writeCount=5
    - Test: empty reader → 0 reads, 0 writes, status COMPLETED
    - Test: processor returns null for 1 item → writeCount=4
    - Test: writer throws → status FAILED
    - Test: reader throws mid-chunk → status FAILED
    - Test: no processor (passthrough) works

  **Must NOT do**: No skip/retry. NO TX wrap (added in Task 23 with policies).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Loop control, count tracking, no policy complexity yet

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 19, 23
  - **Blocked By**: 16, 13

  **References**:
  - Spring Batch `ChunkProvider` / `ChunkProcessor` source
  - Metis: "Chunk step with exactly chunk-size items commits once / Chunk step with chunkSize + 1 items commits twice"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test chunk-step-executor` → green
    - [ ] 6 test cases pass
    - [ ] Counts are accurate (read/write/skip)

  **QA Scenarios**:
  ```
  Scenario: 5 items chunkSize 2 produces 3 chunks
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/chunk-step-executor.test.ts -t "5 items"
    Expected: exit 0, readCount=5, writeCount=5, commitCount=3
    Evidence: .omo/evidence/task-18-chunk-loop.log

  Scenario: Empty reader completes successfully
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/chunk-step-executor.test.ts -t "empty"
    Expected: exit 0, readCount=0, writeCount=0, status COMPLETED
    Evidence: .omo/evidence/task-18-empty-reader.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add ChunkStepExecutor (basic loop, no policies)`
  - Files: `packages/nest-batch/src/execution/chunk-step-executor.ts`, `tests/execution/*.test.ts`

- [x] 19. JobLauncher (entry: get def, init execution, run)

  **What to do**:
  - Create `packages/nest-batch/src/execution/job-launcher.ts`:
    - `@Injectable() export class JobLauncher`
    - Constructor injects `JobRegistry`, `JobRepository`, `TransactionManager`, `JobExecutor` (Task 20)
    - `async launch(jobId: string, params: JobParameters): Promise<JobExecution>`
    - `async run(execution: JobExecution): Promise<JobExecution>` (resume existing)
  - `launch` logic:
    1. `jobDef = jobRegistry.get(jobId)` (throws if not found)
    2. `jobKey = canonicalJobKey(params)` (JSON.stringify with sorted keys, then sha256)
    3. `jobInstance = await jobRepository.getOrCreateJobInstance(jobId, jobKey)`
    4. `jobExecution = await jobRepository.createJobExecution(jobInstance.id, params)`
    5. Return `jobExecutor.execute(jobExecution, jobDef)` (delegate to Task 20)
  - `run` logic: similar but uses existing `JobExecution`
  - Create `packages/nest-batch/src/execution/job-key.ts`:
    - `export function canonicalJobKey(params: JobParameters): string` — JSON.stringify with sorted keys, sha256
  - Create `packages/nest-batch/tests/execution/job-launcher.test.ts`:
    - Test: launch unknown job throws `JobNotFoundError`
    - Test: launch with same params twice returns same `JobInstance` (different `JobExecution` IDs)
    - Test: launch with different param order but same values returns same `JobInstance` (key canonicalization)
    - Test: launch with `allowDuplicateInstances: true` flag creates new instance each time

  **Must NOT do**: No actual step execution logic (delegated to JobExecutor).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Identity, key canonicalization, repo wiring

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 40 (smoke test)
  - **Blocked By**: 9, 12, 13

  **References**:
  - ORACLE verdict 3b: "Job parameter key generation must be canonical and stable"
  - Spring Batch `JobLauncher` source

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-launcher` → green
    - [ ] 4 test cases pass
    - [ ] Key canonicalization verified

  **QA Scenarios**:
  ```
  Scenario: Same params yield same JobInstance
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-launcher.test.ts -t "same params"
    Expected: exit 0, 2 calls return same jobInstanceId
    Evidence: .omo/evidence/task-19-same-instance.log

  Scenario: Different key order yields same JobInstance
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-launcher.test.ts -t "different key order"
    Expected: exit 0
    Evidence: .omo/evidence/task-19-canonical-key.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add JobLauncher with canonical job key + identity semantics`
  - Files: `packages/nest-batch/src/execution/{job-launcher,job-key}.ts`, `tests/execution/*.test.ts`

- [x] 20. JobExecutor + StepExecutor dispatcher + ListenerInvoker

  **What to do**:
  - Create `packages/nest-batch/src/execution/listener-invoker.ts`:
    - `export class ListenerInvoker`
    - `async invokeBefore(jobListeners, execution)`, `invokeAfter(...)`, `invokeOnError(...)` etc.
    - Default listener failure policy: throw → fail step (per Metis)
    - Honors `nonCritical: true` on listener definition (logs + continues)
  - Create `packages/nest-batch/src/execution/job-executor.ts`:
    - `@Injectable() export class JobExecutor`
    - `async execute(execution: JobExecution, jobDef: JobDefinition): Promise<JobExecution>`
    - Logic:
      1. `beforeJob` listeners
      2. Mark execution `STARTED`
      3. Start at `jobDef.startStepId`
      4. Loop:
        - Get current step
        - Dispatch to `TaskletStepExecutor` or `ChunkStepExecutor` based on `step.kind`
        - Get `FlowExecutionStatus` from result + afterStep listeners
        - Find matching transition (`fromStepId + onStatus`)
        - If no transition or `toStepId === null` → END
        - Else: move to next step
      5. Mark execution COMPLETED or FAILED
      6. `afterJob` listeners
    - **Use FlowEvaluator from Task 28** (forward reference or lazy import)
  - Create `packages/nest-batch/tests/execution/job-executor.test.ts`:
    - Test: 1-step job runs to COMPLETED
    - Test: step that throws → execution FAILED
    - Test: job-level listeners invoked (before/after)
    - Test: step-level listeners invoked (before/after)
    - Test: listener that throws → step FAILED (default policy)
    - Test: listener with `nonCritical: true` + throws → step continues

  **Must NOT do**: No skip/retry (Task 23), no flow evaluator logic (Task 28 — stub to always go to next).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Listener orchestration, error policy, dispatcher

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 23, 28, 40
  - **Blocked By**: 17, 18

  **References**:
  - ORACLE verdict 1c: "JobLauncher executes only validated definitions"
  - Metis: "Listener failure follows documented policy / default: fail step"
  - Spring Batch `JobLauncher` / `JobExecutor` pattern

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-executor` → green
    - [ ] 6 test cases pass
    - [ ] Listener ordering verified

  **QA Scenarios**:
  ```
  Scenario: 1-step job runs to COMPLETED
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-executor.test.ts -t "1-step"
    Expected: exit 0, status COMPLETED
    Evidence: .omo/evidence/task-20-job-completed.log

  Scenario: Listener failure fails the step
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-executor.test.ts -t "listener failure"
    Expected: exit 0, status FAILED
    Evidence: .omo/evidence/task-20-listener-failure.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add JobExecutor with step dispatcher + ListenerInvoker (default failure policy)`
  - Files: `packages/nest-batch/src/execution/{job-executor,listener-invoker}.ts`, `tests/execution/*.test.ts`

### Wave 4 — M2: FAILURE SEMANTICS (depends: Wave 3)

- [x] 21. SkipPolicy interface + ConfigSkipPolicy

  **What to do**:
  - Create `packages/nest-batch/src/policies/skip-policy.ts`:
    - `export interface SkipPolicy { shouldSkip(error: unknown, context: SkipContext): boolean; }`
    - `export type SkipContext = { item: unknown; phase: 'read' | 'process' | 'write'; skipCount: number; skipLimit: number; }`
  - Create `packages/nest-batch/src/policies/config-skip-policy.ts`:
    - `export function compileSkipPolicy(config: SkipPolicyConfig): SkipPolicy`
    - `SkipPolicyConfig = { limit: number; skippable: Array<ErrorClass | ((err: unknown) => boolean)> }`
    - Match by error constructor (class identity) or predicate
    - Throws `InvalidFlowGraphError` if `limit <= 0`
  - Create `packages/nest-batch/tests/policies/skip-policy.test.ts`:
    - Test: `compileSkipPolicy({ limit: 3, skippable: [ValidationError] })` skips on `ValidationError`, doesn't skip on other
    - Test: skip count exceeds limit → `shouldSkip` returns false (caller throws `SkipLimitExceededError`)
    - Test: predicate function: `(err) => err.code === 'TEMP'` matches custom errors
    - Test: `limit: 0` throws

  **Must NOT do**: No integration with ChunkProcessor yet (Task 23).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Predicate matching, error class identity

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 22, 23, 24, 25, 26, 27)
  - **Blocks**: 23, 45
  - **Blocked By**: None

  **References**:
  - ORACLE verdict 3d: "config → class 컴파일 / error constructor 또는 predicate 우선, string은 편의용"
  - Metis: "Skippable item increments skip count and job still completes if skip limit not exceeded / Skip limit exceeded marks job FAILED"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test skip-policy` → green
    - [ ] 4 test cases pass

  **QA Scenarios**:
  ```
  Scenario: SkipPolicy matches by error class
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/policies/skip-policy.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-21-skip-policy.log
  ```

  **Commit**: YES
  - Message: `feat(policy): add SkipPolicy interface + ConfigSkipPolicy (config → policy compile)`
  - Files: `packages/nest-batch/src/policies/{skip-policy,config-skip-policy}.ts`, `tests/policies/*.test.ts`

- [x] 22. RetryPolicy interface + ConfigRetryPolicy + BackoffPolicy

  **What to do**:
  - Create `packages/nest-batch/src/policies/retry-policy.ts`:
    - `export interface RetryPolicy { canRetry(error: unknown, context: RetryContext): boolean; backoffMs(attempt: number): number; }`
    - `export type RetryContext = { item: unknown | null; phase: 'read' | 'process' | 'write'; attempt: number; retryLimit: number; }`
  - Create `packages/nest-batch/src/policies/backoff.ts`:
    - `export type BackoffConfig = { type: 'fixed'; ms: number } | { type: 'exponential'; initialMs: number; maxMs?: number; factor?: number } | { type: 'none' }`
    - `export function compileBackoff(config: BackoffConfig): (attempt: number) => number`
  - Create `packages/nest-batch/src/policies/config-retry-policy.ts`:
    - `export function compileRetryPolicy(config: RetryPolicyConfig): RetryPolicy`
    - `RetryPolicyConfig = { limit: number; retryable: Array<ErrorClass | Predicate>; backoff: BackoffConfig }`
  - Create `packages/nest-batch/tests/policies/retry-policy.test.ts`:
    - Test: `canRetry` returns true for matching error within limit, false if exceeded
    - Test: exponential backoff: 100, 200, 400, 800 (or `maxMs` cap)
    - Test: fixed backoff: same ms each attempt
    - Test: `backoff: { type: 'none' }` returns 0

  **Must NOT do**: No actual retry loop (Task 23).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Backoff math, error matching

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 23, 45
  - **Blocked By**: None

  **References**:
  - ORACLE verdict 3d: "config compiled to policy class"
  - Spring Batch `RetryPolicy` (SimpleRetryPolicy, ExponentialBackoffPolicy)
  - Metis guardrail: "support fixed max retry, optional delay/backoff only if explicitly approved" (we have approval via decision)

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test retry-policy` → green
    - [ ] 4 test cases pass
    - [ ] Backoff math verified

  **QA Scenarios**:
  ```
  Scenario: Exponential backoff doubles
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/policies/retry-policy.test.ts -t "exponential"
    Expected: exit 0, 100, 200, 400, 800
    Evidence: .omo/evidence/task-22-exponential-backoff.log
  ```

  **Commit**: YES
  - Message: `feat(policy): add RetryPolicy + BackoffPolicy (fixed/exponential/none) + ConfigRetryPolicy compile`
  - Files: `packages/nest-batch/src/policies/{retry-policy,backoff,config-retry-policy}.ts`, `tests/policies/*.test.ts`

- [x] 23. ChunkProcessor with skip/retry integration (REWRITE Task 18)

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/chunk-step-executor.ts` to integrate skip/retry:
  - Per-phase try-catch:
    ```
    for each chunk:
      1. Read phase:
        for each read attempt:
          try: item = await reader.read()
          catch (err):
            if skipPolicy.shouldSkip(err, ...): skipCount++; continue
            if retryPolicy.canRetry(err, ...): await backoff; retry
            else: throw err
      2. Process phase: per-item try-catch (skip → filter, retry → re-process)
      3. Write phase: per-chunk try-catch (skip → log skip, retry → re-write whole chunk)
    ```
  - Skip limit exceeded: throw `SkipLimitExceededError` (caller catches and marks step FAILED)
  - Retry limit exceeded: throw `RetryLimitExceededError`
  - Invoke `SkipListener` on skips (Task 25)
  - Add TX wrap: `transactionManager.withTransaction(async (txCtx) => { ... process + write ... })`
  - Commit count increments per successful chunk (after TX)
  - Update `packages/nest-batch/tests/execution/chunk-step-executor.test.ts` (replace or extend):
    - Test: skip on read error → skipCount++, rest of items processed
    - Test: skip limit exceeded → throws `SkipLimitExceededError`
    - Test: retry succeeds on 2nd attempt → attempt count tracked
    - Test: retry exhausted → throws `RetryLimitExceededError`
    - Test: write phase retry: writer fails then succeeds
    - Test: skip listener called for each skipped item
    - Test: TX wrap: withTransaction called once per chunk (mockable)

  **Must NOT do**: No flow integration (Task 28).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Complex control flow, error class matching, TX wrap

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 40
  - **Blocked By**: 18, 21, 22, 25

  **References**:
  - ORACLE risk 3: "Read, process, and write failures need different skip/retry semantics"
  - Spring Batch `ChunkProcessor` + `FaultTolerantChunkProcessor` source
  - Metis: "Read/Process/Write 실패 시 다른 skip/retry 의미"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test chunk-step-executor` → green (all original + 7 new tests)
    - [ ] All 13+ test cases pass
    - [ ] TX wrap verifiable

  **QA Scenarios**:
  ```
  Scenario: Read error skipped, rest of chunk processed
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/chunk-step-executor.test.ts -t "skip on read"
    Expected: exit 0, skipCount=1, rest processed
    Evidence: .omo/evidence/task-23-skip-read.log

  Scenario: Writer fails twice, succeeds on 3rd
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/chunk-step-executor.test.ts -t "retry writer"
    Expected: exit 0, writeCount=N, attemptCount=3
    Evidence: .omo/evidence/task-23-retry-writer.log
  ```

  **Commit**: YES
  - Message: `feat(execution): integrate skip/retry policies into ChunkStepExecutor (per-phase try-catch + TX wrap)`
  - Files: `packages/nest-batch/src/execution/chunk-step-executor.ts` (modified), `tests/execution/chunk-step-executor.test.ts` (modified)

- [x] 24. 7 Listener implementations: helper for common patterns

  **What to do**:
  - Create `packages/nest-batch/src/listeners/builtin-listeners.ts`:
    - `export class LoggingListener` — implements all 7 listener kinds, logs lifecycle events to console
    - `export class MetricsListener` — implements Job/Step listener kinds, tracks counts in memory
    - `export class TimingListener` — measures step duration
  - These are reference implementations users can copy
  - Create `packages/nest-batch/tests/listeners/builtin-listeners.test.ts`:
    - Test: `LoggingListener` doesn't throw on any callback
    - Test: `MetricsListener.afterStep` accumulates counts
    - Test: `TimingListener.afterStep` returns ms duration

  **Must NOT do**: No custom user listener types (users provide their own).

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Simple logger/metric accumulator

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 40
  - **Blocked By**: 11, 20

  **References**:
  - Spring Batch built-in listeners (Logging, Metrics via Micrometer)

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test builtin-listeners` → green
    - [ ] 3 test cases pass

  **QA Scenarios**:
  ```
  Scenario: LoggingListener hooks fire without error
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/listeners/builtin-listeners.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-24-builtin-listeners.log
  ```

  **Commit**: YES
  - Message: `feat(listener): add LoggingListener, MetricsListener, TimingListener (reference implementations)`
  - Files: `packages/nest-batch/src/listeners/builtin-listeners.ts`, `tests/listeners/*.test.ts`

- [x] 25. SkipListener support (extension to ListenerInvoker)

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/listener-invoker.ts` to add skip-listener invocation:
    - `invokeOnSkipRead(error, item)`
    - `invokeOnSkipProcess(item, error)`
    - `invokeOnSkipWrite(items, error)`
  - These are called from `ChunkStepExecutor` when skip occurs (Task 23)
  - Create `packages/nest-batch/tests/execution/listener-invoker-skip.test.ts`:
    - Test: `invokeOnSkipRead` calls all `@OnSkipRead` listeners
    - Test: skip listener errors → step fails (default policy) OR logs (if `nonCritical: true`)

  **Must NOT do**: No custom skip-listener types.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Listener orchestration extension, error policy

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 23
  - **Blocked By**: 11, 20

  **References**:
  - Metis: "SkipListener implementation: onSkipInRead/Process/Write"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test listener-invoker-skip` → green
    - [ ] 2 test cases pass

  **QA Scenarios**:
  ```
  Scenario: SkipListener fires for skipped item
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/listener-invoker-skip.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-25-skip-listener.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add skip-listener invocation to ListenerInvoker`
  - Files: `packages/nest-batch/src/execution/listener-invoker.ts` (modified), `tests/execution/listener-invoker-skip.test.ts`

- [x] 26. Listener failure policy verification + `nonCritical` opt-out

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/listener-invoker.ts` to clearly implement:
    - Default: listener throw → fail step (caller catches, marks FAILED)
    - `nonCritical: true` (in `ListenerDefinition`): listener throw → log + continue, never fail
  - Update `packages/nest-batch/tests/execution/listener-invoker.test.ts` (from Task 20):
    - Test: default policy: throwing listener → step FAILED
    - Test: `nonCritical: true` policy: throwing listener → log + step continues
    - Test: `nonCritical: true` is respected on before/after/onError phases
  - Document policy in `packages/nest-batch/src/listener-invoker.ts` JSDoc

  **Must NOT do**: No new listener kinds.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Failure mode handling, opt-out flag

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 40
  - **Blocked By**: 20, 25

  **References**:
  - ORACLE risk 4: "listener failures fail the step, are logged, or are suppressed. Default: listener failure should fail the step unless explicitly marked non-critical"
  - Metis: "Listener failure follows documented policy"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test listener-invoker` → green
    - [ ] 3+ test cases (default fail, nonCritical continues, per-phase) all pass
    - [ ] JSDoc documents the policy

  **QA Scenarios**:
  ```
  Scenario: nonCritical listener does not fail the step
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/listener-invoker.test.ts -t "nonCritical"
    Expected: exit 0, step COMPLETED despite listener throw
    Evidence: .omo/evidence/task-26-noncritical-listener.log
  ```

  **Commit**: YES
  - Message: `feat(execution): formalize listener failure policy (default fail, nonCritical opt-out)`
  - Files: `packages/nest-batch/src/execution/listener-invoker.ts` (modified + JSDoc), `tests/execution/listener-invoker.test.ts` (modified)

- [x] 27. Listener ordering + invocation semantics

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/listener-invoker.ts` to enforce:
    - Listeners invoked in registration order
    - `before*` → execute → `after*` (standard pattern)
    - `onError` only fires if execute throws
    - Listeners of same kind (e.g., 2 `@BeforeStep`) invoked in order of registration
  - Create `packages/nest-batch/tests/execution/listener-ordering.test.ts`:
    - Test: 2 `@BeforeStep` listeners invoked in registration order
    - Test: 2 `@AfterStep` listeners invoked in registration order
    - Test: `onError` not called if no error
    - Test: full sequence: beforeJob → beforeStep → afterStep → afterJob

  **Must NOT do**: No async ordering changes (already async, just confirm order).

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Order verification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: 40
  - **Blocked By**: 20

  **References**:
  - Metis: "Listener invocation order is deterministic"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test listener-ordering` → green
    - [ ] 4 test cases pass

  **QA Scenarios**:
  ```
  Scenario: beforeJob → beforeStep → afterStep → afterJob sequence
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/listener-ordering.test.ts
    Expected: exit 0, sequence matches expected order
    Evidence: .omo/evidence/task-27-listener-ordering.log
  ```

  **Commit**: YES
  - Message: `feat(execution): enforce listener invocation order (registration order, before→execute→after)`
  - Files: `packages/nest-batch/src/execution/listener-invoker.ts` (modified), `tests/execution/listener-ordering.test.ts`

### Wave 5 — M3: FLOW (depends: Wave 3)

- [x] 28. FlowEvaluator (async, transitions)

  **What to do**:
  - Create `packages/nest-batch/src/flow/flow-evaluator.ts`:
    - `export class FlowEvaluator`
    - `async evaluate(transitions: TransitionDefinition[], fromStepId: string, status: FlowExecutionStatus): Promise<string | null /* next stepId or null=END */>`
  - Logic:
    1. Filter `transitions` where `fromStepId === current` AND `onStatus === currentStatus`
    2. If exactly 1 match → return `toStepId` (null = END)
    3. If 0 matches → return null (END with no further steps)
    4. If >1 matches → throw `InvalidFlowGraphError` with code `AMBIGUOUS_TRANSITION`
  - **Async signature** (per ORACLE verdict 3c) — always returns Promise even if no awaits
  - Create `packages/nest-batch/tests/flow/flow-evaluator.test.ts`:
    - Test: single matching transition → returns correct `toStepId`
    - Test: `toStepId: null` → returns null (END)
    - Test: no matching transition → returns null (END)
    - Test: ambiguous (2 matches for same from+on) → throws `AMBIGUOUS_TRANSITION`
    - Test: evaluator ignores transitions from other steps
    - Test: result is a Promise (async)

  **Must NOT do**: No actual step execution.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Async transition logic, error cases

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 29, 30, 31)
  - **Blocks**: 30
  - **Blocked By**: 2 (IR), 3 (status enums)

  **References**:
  - ORACLE verdict 3c: "Make FlowEvaluator.evaluate(...) return Promise<FlowExecutionStatus>"
  - Metis: "Invalid flow graph fails validation: ambiguous transition"
  - Spring Batch `FlowExecution` / `JobExecutionDecider`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test flow-evaluator` → green
    - [ ] 5 test cases pass
    - [ ] Returns Promise

  **QA Scenarios**:
  ```
  Scenario: Ambiguous transition is rejected
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/flow/flow-evaluator.test.ts -t "ambiguous"
    Expected: exit 0, throws InvalidFlowGraphError with AMBIGUOUS_TRANSITION code
    Evidence: .omo/evidence/task-28-ambiguous-transition.log
  ```

  **Commit**: YES
  - Message: `feat(flow): add async FlowEvaluator (transition resolution)`
  - Files: `packages/nest-batch/src/flow/flow-evaluator.ts`, `tests/flow/*.test.ts`

- [x] 29. Flow integration into JobExecutor (replace stub)

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/job-executor.ts` to use `FlowEvaluator`:
    - Replace the stub from Task 20 with actual call to `flowEvaluator.evaluate(transitions, currentStepId, status)`
    - Status comes from step execution result + afterStep listeners (listener can mutate status)
  - Add `FlowEvaluator` as constructor inject
  - Update `packages/nest-batch/tests/execution/job-executor.test.ts` (add new tests):
    - Test: 2-step job with `.on(COMPLETED).end()` after step 1 → job ends after step 1
    - Test: 2-step job with `.on(FAILED).to(recovery)` after step 1 → recovery runs on step 1 fail
    - Test: linear flow (no transitions) runs all steps in order
    - Test: step1 fails, no matching transition → job FAILED
    - Test: afterStep listener overrides status → transition uses overridden status

  **Must NOT do**: No new listener kinds (Task 31 adds transition listener).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Async integration, listener override semantics

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5
  - **Blocks**: 40
  - **Blocked By**: 20, 28

  **References**:
  - ORACLE verdict 3c: "transition evaluation must run after afterStep listeners finish"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-executor` → green
    - [ ] Original 6 tests + 5 new flow tests all pass
    - [ ] Listener status override works

  **QA Scenarios**:
  ```
  Scenario: 2-step job with on(FAILED).to(recovery)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-executor.test.ts -t "flow"
    Expected: exit 0, recovery step runs after step 1 failure
    Evidence: .omo/evidence/task-29-flow-routing.log
  ```

  **Commit**: YES
  - Message: `feat(execution): integrate FlowEvaluator into JobExecutor (transition + listener override)`
  - Files: `packages/nest-batch/src/execution/job-executor.ts` (modified), `tests/execution/job-executor.test.ts` (modified)

- [x] 30. Builder API flow extension: .on().to().from().end() with validation

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/builder/job-builder.ts` to add flow methods (already in design from Task 14, just verify they work and integrate with validator):
    - `.on(status: FlowExecutionStatus): TransitionBuilder` (sets current transition's onStatus)
    - `.to(stepId: string): JobBuilder` (sets toStepId, returns JobBuilder)
    - `.end(): JobBuilder` (sets toStepId=null)
    - `.from(stepId: string): TransitionBuilder` (sets fromStepId)
  - Add tests to `packages/nest-batch/tests/builder/builder-api.test.ts`:
    - Test: chain `.on(FAILED).to('recovery').from('step1')` produces correct transition
    - Test: `.end()` produces `toStepId: null`
    - Test: build with flow that targets non-existent step throws (validator catches)
    - Test: build with ambiguous flow throws

  **Must NOT do**: No new builder methods beyond confirmed API.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Method chaining, validation integration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5
  - **Blocks**: 45
  - **Blocked By**: 14, 28

  **References**:
  - Metis guardrail: "support only on(status).to(step), from(step), end()"
  - little-yellow-bean/nest-batch builder pattern (limited flow support)

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test builder-api` → green
    - [ ] Original 6 + 4 new flow tests all pass
    - [ ] Invalid flow graph caught at build time

  **QA Scenarios**:
  ```
  Scenario: Builder with .on(FAILED).to(recovery) produces valid IR
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/builder/builder-api.test.ts -t "on(FAILED)"
    Expected: exit 0
    Evidence: .omo/evidence/task-30-builder-flow.log
  ```

  **Commit**: YES
  - Message: `feat(builder): add flow transition methods (.on().to().from().end()) with validation`
  - Files: `packages/nest-batch/src/builder/job-builder.ts` (modified), `tests/builder/builder-api.test.ts` (modified)

- [x] 31. Decorator API flow extension: @OnTransition, @FromStep (declarative flow)

  **What to do**:
  - Create `packages/nest-batch/src/decorators/flow.decorator.ts`:
    - `@OnTransition(options: { fromStep: string; onStatus: FlowExecutionStatus; toStep: string | null })` — MethodDecorator
    - Method returns `void` (just a marker; the actual transition is registered via metadata)
    - Optional: method can run logic to decide additional state, but the toStep is fixed by decorator
  - Create `packages/nest-batch/tests/decorators/flow.decorator.test.ts`:
    - Test: `@OnTransition` sets correct metadata
    - Test: `DefinitionCompiler` reads `@OnTransition` metadata and adds to `transitions[]`
  - Update `packages/nest-batch/src/compiler/definition-compiler.ts` to extract `@OnTransition` from method metadata and add to `JobDefinition.transitions`

  **Must NOT do**: No new listener types.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Metadata extraction, parity with Builder API

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5
  - **Blocks**: 40
  - **Blocked By**: 8

  **References**:
  - Spring Batch `@On` annotation (Java)
  - ORACLE: parity contract requires decorator API to express flow

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test flow.decorator` → green
    - [ ] 2 test cases pass
    - [ ] Parity with Builder API: same flow via decorator and builder produces same IR

  **QA Scenarios**:
  ```
  Scenario: @OnTransition decorator produces same IR as builder
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/decorators/flow.decorator.test.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-31-decorator-flow.log
  ```

  **Commit**: YES
  - Message: `feat(decorators): add @OnTransition for declarative flow (parity with Builder API)`
  - Files: `packages/nest-batch/src/decorators/flow.decorator.ts`, `src/compiler/definition-compiler.ts` (modified), `tests/decorators/flow.decorator.test.ts`

### Wave 6 — M4: PERSISTENT REPOSITORY + RESTART (depends: Wave 2)

- [x] 32. Demo app scaffold (Nest + MikroORM + PostgreSQL :5434 + docker-compose)

  **What to do**:
  - Create `apps/demo/package.json`:
    - Name: `@nest-batch/demo`, Nest 10/11, MikroORM latest, @mikro-orm/postgresql, @mikro-orm/cli, csv-parse, pg
  - Create `apps/demo/tsconfig.json` (extends root, Nest standard)
  - Create `apps/demo/nest-cli.json` (Nest CLI config)
  - Create `apps/demo/src/main.ts` (Nest bootstrap, port 3000)
  - Create `apps/demo/src/app.module.ts` (imports config, MikroORM module, batch module)
  - Create `apps/demo/src/config/config.module.ts` (config via @nestjs/config, env validation)
  - Create `docker-compose.yml` (root):
    - PostgreSQL latest image, port 5434:5432, env POSTGRES_USER/PASSWORD/DB
    - Healthcheck via `pg_isready`
    - Volume for data persistence
  - Create `.env.example` with DATABASE_URL
  - Create `apps/demo/test/setup.ts` (vitest setup, load env)
  - Create `apps/demo/src/main.ts` test: `pnpm --filter @nest-batch/demo test` boots the app
  - Verify `docker compose up -d postgres` works
  - Verify `pnpm --filter @nest-batch/demo start:dev` connects to DB

  **Must NOT do**: No batch code yet. App + DB only.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Multi-file Nest scaffold, DB setup

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 33, 34, 35, 36, 37)
  - **Blocks**: 33, 34, 35, 36, 37, 41
  - **Blocked By**: 1 (monorepo)

  **References**:
  - MikroORM NestJS guide: `https://mikro-orm.io/docs/usage-with-nestjs`
  - NestJS ConfigModule: `https://docs.nestjs.com/techniques/configuration`

  **Acceptance Criteria**:
  - [ ] `docker compose up -d postgres` → postgres :5434 ready
  - [ ] `pnpm --filter @nest-batch/demo build` → dist/ produced
  - [ ] `pnpm --filter @nest-batch/demo start:dev` → Nest listens on :3000
  - [ ] `psql -h localhost -p 5434 -U demo -d nest_batch_demo -c "SELECT 1"` → 1

  **QA Scenarios**:
  ```
  Scenario: Docker compose up
    Tool: Bash (docker)
    Steps:
      1. docker compose up -d postgres
      2. docker compose ps
    Expected: postgres service "Up" with port 5434
    Evidence: .omo/evidence/task-32-docker-up.log

  Scenario: App connects to DB
    Tool: Bash (curl + nest start)
    Steps:
      1. pnpm --filter @nest-batch/demo start:dev &
      2. sleep 5
      3. curl -s http://localhost:3000/health
    Expected: 200, "ok"
    Evidence: .omo/evidence/task-32-app-boot.log
  ```

  **Commit**: YES
  - Message: `chore(demo): scaffold Nest + MikroORM + PostgreSQL :5434 + docker-compose`
  - Files: `apps/demo/*`, `docker-compose.yml`, `.env.example`

- [x] 33. MikroORM entities: JobInstance, JobExecution, StepExecution, ExecutionContext rows

  **What to do**:
  - Create `apps/demo/src/entities/job-meta.entities.ts`:
    - `JobInstanceEntity` (table: `batch_job_instance`):
      - `id: string` (PK, UUID)
      - `jobName: string`
      - `jobKey: string`
      - `createdAt: Date`
      - `@Unique([jobName, jobKey])`
    - `JobExecutionEntity` (table: `batch_job_execution`):
      - `id: string` (PK)
      - `jobInstanceId: string` (FK)
      - `status: string` (JobStatus enum as string)
      - `startTime: Date | null`
      - `endTime: Date | null`
      - `exitCode: string` (default '')
      - `exitMessage: string` (default '')
    - `JobExecutionParamsEntity` (table: `batch_job_execution_params`):
      - `jobExecutionId: string` (FK, PK)
      - `paramName: string` (PK, composite)
      - `paramType: 'STRING' | 'DATE' | 'LONG' | 'DOUBLE'`
      - `stringValue: string | null`
      - `dateValue: Date | null`
      - `longValue: number | null`
      - `doubleValue: number | null`
    - `StepExecutionEntity` (table: `batch_step_execution`):
      - `id: string` (PK)
      - `jobExecutionId: string` (FK)
      - `stepName: string`
      - `status: string`
      - `readCount: number` (default 0)
      - `writeCount: number` (default 0)
      - `skipCount: number` (default 0)
      - `rollbackCount: number` (default 0)
      - `commitCount: number` (default 0)
    - `JobExecutionContextEntity` (table: `batch_job_execution_context`):
      - `jobExecutionId: string` (PK, FK)
      - `data: string` (JSON serialized JsonValue)
      - `version: number` (default 0)
    - `StepExecutionContextEntity` (table: `batch_step_execution_context`):
      - `stepExecutionId: string` (PK, FK)
      - `data: string` (JSON serialized JsonValue)
      - `version: number` (default 0)
  - **NOTE**: 6 tables total (Spring Batch uses 6-7; we omit `BATCH_STEP_EXECUTION_PARAMS` per Metis/ORACLE recommendation since step params are derivable from job params + step context).
  - Create `apps/demo/src/migrations/001-create-batch-meta.ts`:
    - MikroORM migration: CREATE TABLE for above 6 tables
  - Add entities to MikroORM config in `app.module.ts`
  - Create `apps/demo/src/entities/job-meta.entities.spec.ts`:
    - Test: each entity has correct field types
    - Test: migration creates expected tables
  - Run `pnpm --filter @nest-batch/demo migration:up` against running PostgreSQL
  - Verify tables exist: `psql ... \dt batch_*`

  **Must NOT do**: No JobRepository implementation (Task 34). No TransactionManager (Task 35).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `db-migrate`
  - **Reason**: ORM entity design, migration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 32, 34, 35, 36, 37)
  - **Blocks**: 34, 35
  - **Blocked By**: 32

  **References**:
  - ORACLE verdict 2b: "low-level aggregate-based methods"
  - Spring Batch meta-tables (BATCH_JOB_INSTANCE, BATCH_JOB_EXECUTION, BATCH_STEP_EXECUTION, BATCH_JOB_EXECUTION_CONTEXT, BATCH_STEP_EXECUTION_CONTEXT)
  - Metis guardrail: "BATCH_STEP_EXECUTION_PARAMS 강제 X"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo migration:up` succeeds
  - [ ] `psql -h localhost -p 5434 -U demo -d nest_batch_demo -c "\dt batch_*"` shows 6 tables
  - [ ] Entity unit tests pass
  - [ ] All entities have correct column types

  **QA Scenarios**:
  ```
  Scenario: Migration creates batch_* tables
    Tool: Bash (psql)
    Steps:
      1. pnpm --filter @nest-batch/demo migration:up
      2. PGPASSWORD=demo psql -h localhost -p 5434 -U demo -d nest_batch_demo -c "\dt batch_*"
    Expected: 6 tables listed
    Evidence: .omo/evidence/task-33-migration-tables.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add JobInstance/JobExecution/StepExecution/ExecutionContext entities + migration`
  - Files: `apps/demo/src/entities/job-meta.entities.ts`, `migrations/001-*`, `tests/entities/*.spec.ts`

- [x] 34. MikroORMJobRepository (implements JobRepository abstract class)

  **What to do**:
  - Create `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts`:
    - `@Injectable() export class MikroORMJobRepository extends JobRepository`
    - Inject `EntityManager` from `@mikro-orm/postgresql`
  - Implement all abstract methods using MikroORM:
    - `getOrCreateJobInstance(name, jobKey)`: find by (name, key), if not exist, create (in TX)
    - `createJobExecution`, `updateJobExecution`, `getJobExecution`: persist + flush
    - `createStepExecution`, `updateStepExecution`, `getStepExecution`: same
    - `getExecutionContext(scope)`: find by (scopeType, scopeId), return `data + version`
    - `saveExecutionContext(scope, ctx, version?)`: deep clone, serialize via serializer (Task 5), upsert
  - Add `MikroORMJobRepository` as provider in `AppModule`
  - Map between `JobInstance` (library type) and `JobInstanceEntity` (ORM type)
  - Create `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.spec.ts`:
    - Test: `getOrCreateJobInstance` creates + returns (round-trip)
    - Test: same name+key → same instance (uniqueness via DB constraint)
    - Test: `saveExecutionContext` with non-serializable data throws
    - Test: `updateStepExecution` increments counts correctly
  - All tests use real PostgreSQL (per ORACLE: integration tests with PostgreSQL only after contract tests pass — these are first adapter integration tests)

  **Must NOT do**: No restart logic (Task 37), no concurrency lock (Task 38).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: ORM mapping, TX-aware persistence, type marshaling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 32, 33, 35, 36, 37)
  - **Blocks**: 40, 45
  - **Blocked By**: 4 (abstract class), 33 (entities)

  **References**:
  - ORACLE verdict 2b: "low-level aggregate-based"
  - ORACLE risk 7: "serialization contract"
  - Metis: "Persistent repository must be paired with checkpoint and locking semantics" (locking is Task 38)

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test mikroorm-job-repository` → green (4 tests, real DB)
  - [ ] All abstract methods implemented
  - [ ] `data` field in DB is valid JSON
  - [ ] Uniqueness constraint verified at DB level

  **QA Scenarios**:
  ```
  Scenario: getOrCreateJobInstance creates and returns
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run apps/demo/src/adapters/mikroorm/mikroorm-job-repository.spec.ts
    Expected: exit 0, returns JobInstance with valid ID
    Evidence: .omo/evidence/task-34-mikroorm-repo.log

  Scenario: Same name+key returns same instance (real DB constraint)
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/adapters/mikroorm/mikroorm-job-repository.spec.ts -t "uniqueness"
    Expected: exit 0, 2 calls → 1 instance
    Evidence: .omo/evidence/task-34-db-uniqueness.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add MikroORMJobRepository implementing JobRepository abstract class`
  - Files: `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts`, `*.spec.ts`, `app.module.ts` (provider)

- [x] 35. MikroORMTransactionManager (EntityManager.transaction())

  **What to do**:
  - Create `apps/demo/src/adapters/mikroorm/mikroorm-transaction-manager.ts`:
    - `@Injectable() export class MikroORMTransactionManager extends TransactionManager`
    - Inject `EntityManager` from `@mikro-orm/postgresql`
    - `async withTransaction<T>(fn: (ctx: MikroOrmTransactionContext) => Promise<T>): Promise<T>`
    - `MikroOrmTransactionContext = { entityManager: EntityManager; isActive: true }`
    - Use `entityManager.transactional(async (em) => fn({ entityManager: em, isActive: true }))`
  - Add as provider in `AppModule` (override default `InMemoryTransactionManager`)
  - Create `apps/demo/src/adapters/mikroorm/mikroorm-transaction-manager.spec.ts`:
    - Test: `withTransaction` invokes `fn` with context containing active `entityManager`
    - Test: if `fn` throws, transaction is rolled back (verify by inserting in fn, throwing, then checking not in DB)
    - Test: nested `withTransaction` shares same connection (use savepoint or just verify)

  **Must NOT do**: No job-level TX semantics (that's JobExecutor's responsibility).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: ORM TX hook, rollback verification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 32, 33, 34, 36, 37)
  - **Blocks**: 40, 45
  - **Blocked By**: 4, 32

  **References**:
  - ORACLE verdict 3a: "let MikroORM/TypeORM adapters bind their transaction manager"
  - MikroORM transactional helper: `https://mikro-orm.io/docs/transactions`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test mikroorm-transaction-manager` → green (3 tests)
  - [ ] Rollback verified (insert in fn, throw, check DB)
  - [ ] Adapter injected as `TransactionManager` token

  **QA Scenarios**:
  ```
  Scenario: TX rollback on function throw
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run apps/demo/src/adapters/mikroorm/mikroorm-transaction-manager.spec.ts
    Expected: exit 0, inserted data not visible after throw
    Evidence: .omo/evidence/task-35-tx-rollback.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add MikroORMTransactionManager with TX rollback`
  - Files: `apps/demo/src/adapters/mikroorm/mikroorm-transaction-manager.ts`, `*.spec.ts`

- [x] 36. JobInstance identity + canonical job key normalization

  **What to do**:
  - **VERIFY** `packages/nest-batch/src/execution/job-key.ts` (from Task 19) handles edge cases:
    - Object key order: `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` → same hash
    - Nested objects: same canonical form
    - Arrays: preserve order (different order = different key)
    - Date: serialize as ISO string
    - Number: `1` and `1.0` → same (or document difference)
    - null/undefined: omit from key
    - String: trim whitespace (or document preserving)
  - Create `packages/nest-batch/tests/execution/job-key.test.ts` (add to existing):
    - Test: `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` → same hash
    - Test: different order in nested array → different hash
    - Test: `null` param is omitted
    - Test: `Date` param serializes to ISO
    - Test: `undefined` value is omitted
    - Test: empty params `{}` → same hash
  - **MODIFY** `packages/nest-batch/src/execution/job-key.ts` if any test fails (canonical JSON.stringify with sorted keys, sha256)
  - **NOTE**: This is a verification/edge case task, not a new feature

  **Must NOT do**: No new methods.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Edge case verification, serialization correctness

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6
  - **Blocks**: 38
  - **Blocked By**: 19

  **References**:
  - ORACLE verdict 3b: "Job parameter key generation must be canonical and stable: object key order, dates, numbers, undefined/null, and secrets must be normalized consistently"
  - Metis: "Re-running COMPLETED job with same params / Launching same job+params concurrently"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test job-key` → green (all 6+ tests)
  - [ ] Object key order independence verified
  - [ ] Date normalization verified
  - [ ] null/undefined omission verified

  **QA Scenarios**:
  ```
  Scenario: Object key order independence
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/job-key.test.ts -t "key order"
    Expected: exit 0
    Evidence: .omo/evidence/task-36-key-canonicalization.log
  ```

  **Commit**: YES
  - Message: `feat(execution): harden canonical job key (object order, dates, null/undefined)`
  - Files: `packages/nest-batch/src/execution/job-key.ts` (modified if needed), `tests/execution/job-key.test.ts`

- [x] 37. Restart support: resume from last committed chunk (demo-level restart)

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/job-executor.ts`:
    - On launch with existing failed `JobExecution` for same `JobInstance` (and `restartable: true`):
      1. Load `StepExecution` rows where `status !== COMPLETED`
      2. For each, check if reader has `ExecutionContext` with `lastProcessedIndex` (or similar checkpoint)
      3. Resume from that point
  - **MODIFY** `packages/nest-batch/src/execution/chunk-step-executor.ts`:
    - Before each chunk read: check `ExecutionContext` for `lastChunkIndex` checkpoint
    - After each successful chunk write: save `lastChunkIndex` to ExecutionContext
  - **NOTE**: Per Metis "영감 수준: last committed chunk resume, item-level checkpoint X" — keep it simple
  - Add tests:
    - Test: launch with existing failed execution, step context has checkpoint → resume from next chunk
    - Test: launch with no checkpoint → start from beginning
    - Test: in-memory repo (non-restartable) → throw on restart attempt
  - **Documentation**: Add README section "Restartability" explaining the simple semantic

  **Must NOT do**: No item-level checkpointing, no reader position tracking (CSV file position is a stretch).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: ExecutionContext checkpoint integration, restart logic

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6
  - **Blocks**: 48
  - **Blocked By**: 19, 23, 34

  **References**:
  - Metis: "영감 수준: last committed chunk resume, item-level checkpoint X"
  - ORACLE verdict 3b: "default-on for persisted repositories"

  **Acceptance Criteria**:
  - [ ] `pnpm -r test restart` → green
  - [ ] In-memory restart attempt throws (non-restartable)
  - [ ] MikroORM repo resumes from checkpoint
  - [ ] Restart with no checkpoint starts fresh

  **QA Scenarios**:
  ```
  Scenario: Restart resumes from last committed chunk
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/restart.test.ts
    Expected: exit 0, second run starts from chunkIndex=2 (after first run stopped at 1)
    Evidence: .omo/evidence/task-37-restart-resume.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add restart support (last committed chunk resume)`
  - Files: `packages/nest-batch/src/execution/{job-executor,chunk-step-executor}.ts` (modified), `tests/execution/restart.test.ts`

### Wave 7 — M4: CONCURRENCY + OBSERVABILITY HOOKS + LIBRARY SMOKE (depends: Wave 6)

- [x] 38. Concurrency control: same jobName+jobKey already running → reject

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/execution/job-launcher.ts`:
    - After `getOrCreateJobInstance`, check for existing `JobExecution` with status STARTING/STARTED
    - If exists → throw `JobExecutionAlreadyRunningError`
  - **MODIFY** `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts`:
    - Add helper `getRunningJobExecution(jobInstanceId): Promise<JobExecution | null>` (filter by status in [STARTING, STARTED])
  - Create `packages/nest-batch/tests/execution/concurrent-launch.test.ts`:
    - Test: launch same job+params twice concurrently → second throws `JobExecutionAlreadyRunningError`
    - Test: launch same job different params → both succeed
    - Test: launch same job+params after first COMPLETED → succeeds (new execution)
    - Test: launch same job+params after first FAILED (restartable) → succeeds (resumes or new)
  - **NOTE**: True distributed lock requires DB-level advisory locks. For MVP, use DB query to find running — race window is small but exists. Document this.

  **Must NOT do**: No advisory locks (would require MikroORM-specific extension). DB query is MVP-acceptable.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Concurrency semantics, race condition handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7
  - **Blocks**: 40, 48
  - **Blocked By**: 19, 34, 36

  **References**:
  - ORACLE risk 6: "Concurrency controls: Define whether the same job instance can run concurrently. Default should be no concurrent execution for same jobName + jobKey for persisted repositories"
  - Metis: "Concurrent launch of same job+params is rejected or locked deterministically"
  - Metis E2E: "Concurrent launch of same job+params: one execution starts, second is rejected with deterministic conflict error, e.g. JobExecutionAlreadyRunning"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test concurrent-launch` → green (4 tests)
  - [ ] Real DB test: 2 parallel `launch` calls → 1 succeeds, 1 throws
  - [ ] Different params → both succeed

  **QA Scenarios**:
  ```
  Scenario: Concurrent launch with same params is rejected
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/execution/concurrent-launch.test.ts
    Expected: exit 0, second call throws JobExecutionAlreadyRunningError
    Evidence: .omo/evidence/task-38-concurrent-reject.log
  ```

  **Commit**: YES
  - Message: `feat(execution): add concurrency control (same jobName+jobKey running → reject)`
  - Files: `packages/nest-batch/src/execution/job-launcher.ts` (modified), `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts` (modified), `tests/execution/concurrent-launch.test.ts`

- [x] 39. Observability naming + standard IDs (UUID v7, count schemas)

  **What to do**:
  - **MODIFY** `packages/nest-batch/src/repository/id-generator.ts` (created in Task 13):
    - `UuidV7IdGenerator` (time-sortable UUIDs) — preferred for execution IDs
    - Keep `UuidIdGenerator` (v4) as default for tests
    - Export `IdGenerator` interface
  - Create `packages/nest-batch/src/observability/event-types.ts`:
    - Define event type constants (no emitters yet — just type-safe strings):
      - `BATCH_JOB_STARTED = 'nest-batch.job.started'`
      - `BATCH_JOB_COMPLETED = 'nest-batch.job.completed'`
      - `BATCH_JOB_FAILED = 'nest-batch.job.failed'`
      - `BATCH_STEP_STARTED = 'nest-batch.step.started'`
      - `BATCH_STEP_COMPLETED = 'nest-batch.step.completed'`
      - `BATCH_STEP_FAILED = 'nest-batch.step.failed'`
      - `BATCH_CHUNK_PROCESSED = 'nest-batch.chunk.processed'`
      - `BATCH_ITEM_SKIPPED = 'nest-batch.item.skipped'`
      - `BATCH_ITEM_RETRIED = 'nest-batch.item.retried'`
    - `BatchEvent = { type: BatchEventType; timestamp: Date; jobExecutionId: string; stepExecutionId?: string; data: JsonValue }`
  - **MODIFY** `JobExecutor` to emit events (using simple EventEmitter or just call observer function):
    - Use `@nestjs/event-emitter` or custom `BatchObserver` interface
    - For MVP: define `BatchObserver` interface, default no-op implementation
  - **DO NOT** add OpenTelemetry/Prometheus exporters (per Must NOT Have)
  - Tests:
    - Test: `UuidV7IdGenerator` produces time-sortable IDs
    - Test: `BatchObserver` receives correct events in order for a simple job run

  **Must NOT do**: No actual exporters, no metrics collection library.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Standardization, naming, observer pattern

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7
  - **Blocks**: 40
  - **Blocked By**: 19, 20

  **References**:
  - ORACLE risk 8: "Standardize job execution IDs, step execution IDs, status transitions, counts, and listener events early. Retrofitting logs/metrics after the executor exists is painful"
  - Metis: "Define exact behavior"
  - Metis guardrail: "Observability bloat: avoid exporter dependencies unless explicitly chosen"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test observability` → green
  - [ ] UUID v7 IDs are time-sortable
  - [ ] Event types are exported as constants
  - [ ] BatchObserver receives events for a real job run

  **QA Scenarios**:
  ```
  Scenario: UUID v7 IDs are time-sortable
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run packages/nest-batch/tests/observability/uuid-v7.test.ts
    Expected: exit 0, IDs sorted by time
    Evidence: .omo/evidence/task-39-uuid-v7.log
  ```

  **Commit**: YES
  - Message: `feat(observability): add UuidV7IdGenerator + BatchObserver interface + standard event types`
  - Files: `packages/nest-batch/src/repository/id-generator.ts` (modified), `src/observability/*.ts`, `tests/observability/*.test.ts`

- [x] 40. Library smoke test: end-to-end with in-memory + decorator API

  **What to do**:
  - Create `packages/nest-batch/tests/e2e/library-smoke.test.ts` (vitest):
    - Test: full job definition via decorator API:
      - `@Jobable({ id: 'smoke-job' }) class SmokeJob { @BeforeJob() @AfterJob() ... @Stepable({ id: 'step1' }) @Tasklet() async ... }`
    - Boot minimal Nest test app: `Test.createTestingModule({ imports: [NestBatchModule.forRoot(), /* InMemoryJobRepository, InMemoryTransactionManager */] }).compile()`
    - Launch job via `JobLauncher.launch('smoke-job', { file: 'x.csv' })`
    - Verify: execution COMPLETED, listeners fired, counts recorded
  - Create `packages/nest-batch/tests/e2e/library-smoke-builder.test.ts`:
    - Same but using Builder API
  - Create `packages/nest-batch/tests/e2e/library-smoke-parity.test.ts`:
    - Same job via decorator and builder → both succeed, both produce equivalent execution structure
  - Run all E2E: `pnpm --filter @nest-batch/core test:e2e`

  **Must NOT do**: No real DB, no demo. Pure library.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: End-to-end integration, Nest module boot, API parity verification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7
  - **Blocks**: 48
  - **Blocked By**: 12, 14, 19, 20, 23, 28, 29, 30, 31, 38, 39

  **References**:
  - All Wave 1-7 components

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/core test:e2e` → all green
  - [ ] Smoke test (decorator) → COMPLETED
  - [ ] Smoke test (builder) → COMPLETED
  - [ ] Parity test → both produce equivalent execution

  **QA Scenarios**:
  ```
  Scenario: Library E2E with decorator API
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/core test:e2e
    Expected: exit 0, 3+ tests pass (decorator, builder, parity)
    Evidence: .omo/evidence/task-40-library-smoke.log
  ```

  **Commit**: YES
  - Message: `test(core): add library E2E smoke test (decorator, builder, parity)`
  - Files: `packages/nest-batch/tests/e2e/*.test.ts`

### Wave 8 — M5: DEMO APP FULL FEATURE (depends: Wave 7)

- [x] 41. Demo Product entity + CSV fixtures (3 files)

  **What to do**:
  - Create `apps/demo/src/entities/product.entity.ts`:
    - `@Entity() @Unique({ properties: ['sku'] }) class ProductEntity { id: string; name: string; sku: string; price: number; category: string; createdAt: Date; }`
  - Create migration: `apps/demo/src/migrations/002-create-product.ts`
  - Run migration: `pnpm --filter @nest-batch/demo migration:up`
  - Create `apps/demo/src/constants/categories.ts`:
    - `export const VALID_CATEGORIES = ['electronics', 'books', 'clothing', 'food'] as const`
    - `export type ProductCategory = typeof VALID_CATEGORIES[number]`
    - `export function isValidCategory(s: string): s is ProductCategory`
  - **DEMO ASSUMPTION**: The category list `electronics/books/clothing/food` is invented for the demo (not specified in user interview). User can override this list post-plan. Documented in plan so it's explicit.
  - Create CSV fixtures (3 files):
    - `apps/demo/sample-data/products-valid.csv`:
      ```
      id,name,sku,price,category
      1,Widget,SKU-001,9.99,electronics
      2,Gadget,SKU-002,19.99,electronics
      3,Book,SKU-003,12.50,books
      ```
    - `apps/demo/sample-data/products-with-errors.csv`:
      ```
      id,name,sku,price,category
      1,Widget,SKU-001,9.99,electronics
      2,DuplicateSku,SKU-001,15.00,books  (duplicate SKU → skip)
      3,FreeItem,SKU-004,0,food  (price=0 → skip)
      4,BadCategory,SKU-005,5.00,unknown  (invalid category → skip)
      5,GoodItem,SKU-006,7.50,clothing
      ```
    - `apps/demo/sample-data/products-malformed.csv`:
      ```
      id,name,sku,price
      1,Widget,SKU-001,9.99  (missing category column)
      ```
  - Create `apps/demo/src/entities/product.entity.spec.ts`:
    - Test: `ProductEntity` schema correct
    - Test: SKU uniqueness constraint verified at DB level

  **Must NOT do**: No reader/processor/writer (Tasks 42-44). No job (Task 45).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Entity + migration + fixtures

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8 (with Tasks 42-48)
  - **Blocks**: 42, 43, 44
  - **Blocked By**: 32, 33

  **References**:
  - Metis: "Fixed concrete CSV fixtures, not placeholders"
  - User: "Product (id, name, sku, price, category)"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo migration:up` → all migrations applied
  - [ ] 3 CSV files exist with correct content
  - [ ] `psql -c "\d product"` → product table with sku UNIQUE
  - [ ] Entity tests pass

  **QA Scenarios**:
  ```
  Scenario: Product table created with unique SKU
    Tool: Bash (psql)
    Steps:
      1. pnpm --filter @nest-batch/demo migration:up
      2. PGPASSWORD=demo psql -h localhost -p 5434 -U demo -d nest_batch_demo -c "\d product"
    Expected: product table with UNIQUE constraint on sku
    Evidence: .omo/evidence/task-41-product-table.log

  Scenario: Valid CSV has 3 rows
    Tool: Bash
    Steps:
      1. wc -l apps/demo/sample-data/products-valid.csv
    Expected: 4 (1 header + 3 data)
    Evidence: .omo/evidence/task-41-csv-fixtures.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add Product entity + migration + 3 CSV fixtures`
  - Files: `apps/demo/src/entities/product.entity.ts`, `migrations/002-*`, `sample-data/*.csv`, `constants/categories.ts`

- [x] 42. CsvProductReader (csv-parse, header validation)

  **What to do**:
  - Create `apps/demo/src/jobs/import-products/reader/csv-product.reader.ts`:
    - `@Injectable() export class CsvProductReader implements ItemReader<RawProductRow>`
    - `RawProductRow = { id: string; name: string; sku: string; price: string; category: string }`
    - Constructor injects file path (via env or param)
    - Uses `csv-parse` with `{ columns: true, skip_empty_lines: true, trim: true, bom: true }`
    - `async read(): Promise<RawProductRow | null>` — reads one row at a time, uses `parse` in stream mode
    - On EOF: returns null
    - On missing required column (header check at init): throws `InvalidFlowGraphError` with code `MALFORMED_CSV`
  - Create `apps/demo/src/jobs/import-products/reader/csv-product.reader.spec.ts`:
    - Test: read 3 rows from valid CSV → 3 then null
    - Test: malformed CSV (missing column) → throws at init
    - Test: empty CSV → first read returns null
    - Test: BOM character handled

  **Must NOT do**: No validation (Task 43), no DB write (Task 44).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Stream-based CSV parsing, edge cases

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 45
  - **Blocked By**: 16, 41

  **References**:
  - csv-parse docs: `https://csv.js.org/parse/`
  - Metis: "UTF-8 BOM, CRLF vs LF, Whitespace trimming, Header-only CSV, Empty CSV"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test csv-product-reader` → green (4 tests)
  - [ ] Reads valid CSV correctly
  - [ ] Malformed CSV throws on init
  - [ ] Empty CSV returns null immediately

  **QA Scenarios**:
  ```
  Scenario: CsvProductReader reads valid CSV
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/reader/csv-product.reader.spec.ts
    Expected: exit 0, 3 reads then null
    Evidence: .omo/evidence/task-42-csv-reader.log

  Scenario: Malformed CSV throws on init
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/reader/csv-product.reader.spec.ts -t "malformed"
    Expected: exit 0, throws InvalidFlowGraphError
    Evidence: .omo/evidence/task-42-malformed-csv.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add CsvProductReader with header validation`
  - Files: `apps/demo/src/jobs/import-products/reader/*.ts`, `*.spec.ts`

- [x] 43. ProductProcessor (validation: sku dup, price > 0, category)

  **What to do**:
  - Create `apps/demo/src/jobs/import-products/processor/product.processor.ts`:
    - `@Injectable() export class ProductProcessor implements ItemProcessor<RawProductRow, ProductEntity | null>`
    - Validates each row:
      - `parseFloat(price) > 0` else throw `InvalidProductError` (code: `INVALID_PRICE`)
      - `isValidCategory(category)` else throw `InvalidProductError` (code: `INVALID_CATEGORY`)
      - Note: SKU duplicate check happens in **writer** (DB-level constraint)
    - `async process(item: RawProductRow): Promise<ProductEntity | null>`
    - Returns `ProductEntity` instance, or `null` to filter
  - Create `apps/demo/src/errors/invalid-product.error.ts`:
    - `InvalidProductError extends BatchError { code: 'INVALID_PRODUCT'; field: string; value: string }`
  - Create `apps/demo/src/jobs/import-products/processor/product.processor.spec.ts`:
    - Test: valid row → returns ProductEntity
    - Test: price=0 → throws `InvalidProductError` with field=price
    - Test: invalid category → throws `InvalidProductError` with field=category
    - Test: missing field → throws (e.g., empty name)

  **Must NOT do**: No DB write (Task 44), no skip policy (configured in Task 45).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Validation logic, error class hierarchy

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 45
  - **Blocked By**: 16, 41

  **References**:
  - Metis: "Duplicate SKU rows are skipped and reported / price <= 0 rows are skipped and reported / invalid category rows are skipped and reported"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test product-processor` → green (4 tests)
  - [ ] Valid row → ProductEntity
  - [ ] Invalid row → InvalidProductError with correct field

  **QA Scenarios**:
  ```
  Scenario: Invalid price throws InvalidProductError
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/processor/product.processor.spec.ts -t "price"
    Expected: exit 0
    Evidence: .omo/evidence/task-43-price-error.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add ProductProcessor with field-level validation`
  - Files: `apps/demo/src/jobs/import-products/processor/*.ts`, `errors/invalid-product.error.ts`, `*.spec.ts`

- [x] 44. ProductWriter (MikroORM bulk insert, transactional)

  **What to do**:
  - Create `apps/demo/src/jobs/import-products/writer/product.writer.ts`:
    - `@Injectable() export class ProductWriter implements ItemWriter<ProductEntity>`
    - Inject `EntityManager` (MikroORM)
    - `async write(items: ProductEntity[]): Promise<void>` — `entityManager.persist(items); entityManager.flush()`
    - Catches `UniqueConstraintViolationException` (MikroORM) for SKU dup → throws `DuplicateSkuError` (code: `DUPLICATE_SKU`) for skip policy
  - Create `apps/demo/src/errors/duplicate-sku.error.ts`:
    - `DuplicateSkuError extends BatchError { code: 'DUPLICATE_SKU'; sku: string }`
  - Create `apps/demo/src/jobs/import-products/writer/product.writer.spec.ts`:
    - Test: writes 3 valid products → 3 in DB
    - Test: 2 valid + 1 with duplicate SKU → throws `DuplicateSkuError` for the duplicate
    - Test: empty items array → no-op
    - Test: TX wrap (already in ChunkStepExecutor) verified

  **Must NOT do**: No chunk size logic (Task 18), no retry policy (Task 45).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: ORM-specific exception handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 45
  - **Blocked By**: 16, 33, 41

  **References**:
  - MikroORM exception types: `https://mikro-orm.io/docs/exceptions`
  - ORACLE risk 3: "Write failures may represent a whole chunk or a single item"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test product-writer` → green (4 tests, real DB)
  - [ ] Valid products persisted
  - [ ] Duplicate SKU → DuplicateSkuError
  - [ ] Empty array → no-op

  **QA Scenarios**:
  ```
  Scenario: Valid products are written to DB
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/writer/product.writer.spec.ts
    Expected: exit 0, 3 products in DB
    Evidence: .omo/evidence/task-44-writer-success.log

  Scenario: Duplicate SKU throws DuplicateSkuError
    Tool: Bash (vitest, real DB)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/writer/product.writer.spec.ts -t "duplicate"
    Expected: exit 0
    Evidence: .omo/evidence/task-44-duplicate-sku.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add ProductWriter with MikroORM bulk insert + duplicate SKU detection`
  - Files: `apps/demo/src/jobs/import-products/writer/*.ts`, `errors/duplicate-sku.error.ts`, `*.spec.ts`

- [x] 45. ImportProducts job: 2 steps via Flow (validateCsv → importProducts)

  **What to do**:
  - Create `apps/demo/src/jobs/import-products/import-products.job.ts` (using **Builder API** for demo):
    ```typescript
    // Linear flow: validate-csv → import-products (chunk step)
    // Per draft: "validateCsv 통과 시에만 importProducts 실행 (Flow 조건 분기)"
    // → implemented as tasklet-step preceding chunk-step; chunk-step only runs if tasklet succeeds
    const job = BatchBuilder.create().job('import-products', { restartable: true })
      .addStep(s => s.tasklet('validate-csv', ValidateCsvTasklet))
      .addStep(s => s.chunk(10, {
        reader: CsvProductReader,
        processor: ProductProcessor,
        writer: ProductWriter,
        skipPolicy: { limit: 100, skippable: [InvalidProductError, DuplicateSkuError] },
        retryPolicy: { limit: 3, retryable: [TransientDbError], backoff: { type: 'exponential', initialMs: 100 } },
      }))
      .build();
    // No explicit transitions → linear flow (both steps run in order; second runs only if first COMPLETED)
    ```
  - Create `apps/demo/src/jobs/import-products/validate-csv.tasklet.ts`:
    - `class ValidateCsvTasklet implements Tasklet` — checks file exists, has header, has at least 1 data row
  - Register the job in `AppModule` (or via `NestBatchModule.forRoot` dynamic config)
  - Add to `JobRegistry` on module init
  - Create `apps/demo/src/jobs/import-products/import-products.job.spec.ts`:
    - Test: job registered with correct name
    - Test: build with valid config produces correct IR (2 steps, 0 explicit transitions, linear)
    - Test: build with bad step target throws
    - Test (failure): validate-csv tasklet throws → chunk step NOT executed (Task 48 E2E verifies)

  **Must NOT do**: No REST endpoint (Task 47), no listeners (Task 46), no recovery flow (kept simple per user "validateCsv 통과 시에만 importProducts 실행" — linear, not recovery-loop).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Job composition with builder, policy wiring

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 46, 47, 48
  - **Blocked By**: 14, 42, 43, 44

  **References**:
  - User: "validateCsv step 통과 시에만 importProducts step 실행 (Flow 조건 분기)"
  - Metis: "Flow routing: validateCsv fails → importProducts not executed, configured recovery/end transition executes"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test import-products.job` → green
  - [ ] Job registered in JobRegistry
  - [ ] IR has 2 steps + 0 explicit transitions (linear)

  **QA Scenarios**:
  ```
  Scenario: Job is registered with builder
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/import-products.job.spec.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-45-job-registered.log
  ```

  **Commit**: YES
  - Message: `feat(demo): compose ImportProducts job (2 steps + flow + skip/retry policies)`
  - Files: `apps/demo/src/jobs/import-products/{import-products.job,validate-csv.tasklet}.ts`, `*.spec.ts`

- [x] 46. SkipLoggerListener + StepMetricsListener (demo-specific)

  **What to do**:
  - Create `apps/demo/src/jobs/import-products/listeners/skip-logger.listener.ts`:
    - `@Injectable() export class SkipLoggerListener` — implements `onSkipInRead/Process/Write`
    - Logs each skip with item context via Nest Logger
  - Create `apps/demo/src/jobs/import-products/listeners/step-metrics.listener.ts`:
    - `@Injectable() export class StepMetricsListener` — implements `beforeStep/afterStep`
    - Records step start/end time, count summary to console
  - Register both listeners in the job definition (Task 45)
  - Create `apps/demo/src/jobs/import-products/listeners/listeners.spec.ts`:
    - Test: SkipLoggerListener logs on skip call
    - Test: StepMetricsListener tracks start/end

  **Must NOT do**: No actual metrics export (per Must NOT Have).

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: (none)
  - **Reason**: Simple logging + metric tracking

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 48
  - **Blocked By**: 24, 45

  **References**:
  - Metis: "Listeners: Job·Step·Item·Chunk 리스너"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test listeners` → green
  - [ ] SkipLoggerListener called on skip
  - [ ] StepMetricsListener tracks duration

  **QA Scenarios**:
  ```
  Scenario: SkipLoggerListener receives skip event
    Tool: Bash (vitest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/jobs/import-products/listeners/listeners.spec.ts
    Expected: exit 0
    Evidence: .omo/evidence/task-46-skip-listener.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add SkipLoggerListener + StepMetricsListener`
  - Files: `apps/demo/src/jobs/import-products/listeners/*.ts`, `*.spec.ts`

- [x] 47. REST endpoint: POST /jobs/import-products

  **What to do**:
  - Create `apps/demo/src/controller/batch.controller.ts`:
    - `@Controller('jobs') @Injectable() export class BatchController`
    - `constructor(@Inject(JobLauncher) private launcher: JobLauncher)` (or DI by class)
    - `@Post('import-products') async importProducts(@Body() body: { file: string; jobParams?: Record<string, unknown> }): Promise<{ executionId: string; status: JobStatus }>`
    - Validates `body.file` exists, returns 400 on missing
    - Calls `launcher.launch('import-products', { file: body.file, ...body.jobParams })`
    - Returns `{ executionId: jobExecution.id, status: jobExecution.status }` (200)
  - Add `BatchController` to `AppModule` controllers
  - Create `apps/demo/src/controller/batch.controller.spec.ts`:
    - Test: POST with valid file → 200, returns execution info
    - Test: POST with missing file → 400
    - Test: POST with unknown job name → 404 or 500 with JobNotFoundError

  **Must NOT do**: No async job execution (sync for MVP simplicity, returns after launch).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Nest controller + DTO validation + error handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 8
  - **Blocks**: 48
  - **Blocked By**: 12, 19, 45

  **References**:
  - User: "Demo trigger: REST endpoint (수동/자동)"
  - Metis E2E: "REST launch via curl"

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test batch.controller` → green (3 tests)
  - [ ] `curl -X POST .../jobs/import-products -d '{"file":"..."}'` returns 200
  - [ ] Missing file returns 400
  - [ ] Unknown job returns error

  **QA Scenarios**:
  ```
  Scenario: POST /jobs/import-products with valid file
    Tool: Bash (supertest)
    Steps:
      1. pnpm exec vitest run apps/demo/src/controller/batch.controller.spec.ts
    Expected: exit 0, returns 200 with executionId
    Evidence: .omo/evidence/task-47-rest-endpoint.log
  ```

  **Commit**: YES
  - Message: `feat(demo): add POST /jobs/import-products REST endpoint`
  - Files: `apps/demo/src/controller/batch.controller.ts`, `*.spec.ts`, `app.module.ts` (controller)

- [x] 48. 10 E2E test scenarios (supertest + fixtures + docker)

  **What to do**:
  - Create `apps/demo/tests/e2e/import-products.e2e.spec.ts`:
    - Setup: `docker compose up -d postgres`, `pnpm exec vitest --run` (vitest with `e2e` env)
    - Each test: fresh DB (truncate tables), boot Nest app, run scenario
    - **10 scenarios** (per Metis + plan):
      1. **Happy path**: `products-valid.csv` → status COMPLETED, 3 products, 0 skips
      2. **Skip behavior**: `products-with-errors.csv` → status COMPLETED, 2 valid products, 3 skips, skip listener fired 3 times
      3. **Skip limit exceeded**: CSV with >100 invalid rows → status FAILED, `SkipLimitExceededError`
      4. **Retry success**: mock writer that fails twice then succeeds (custom test writer) → status COMPLETED, retryCount=2
      5. **Retry exhausted**: writer that always fails → status FAILED, `RetryLimitExceededError`
      6. **Restart after crash**: launch, simulate crash (kill process or set flag to fail at chunk 1), restart → no duplicate products, total count correct
      7. **Concurrent launch**: 2 parallel POSTs with same params → 1 succeeds, 1 returns 409 with `JobExecutionAlreadyRunningError`
      8. **Flow routing**: CSV that fails validateCsv step (malformed header) → import step NOT executed, job FAILED
      9. **Malformed CSV**: `products-malformed.csv` → status FAILED with clear error
      10. **Listener failure**: register listener that throws (non-critical) → step COMPLETED, listener throw logged
  - Add `test:e2e` script in `apps/demo/package.json`:
    ```
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
    ```
  - Create `apps/demo/vitest.e2e.config.ts` (separate config, longer timeout, sequential)
  - All scenarios save evidence to `.omo/evidence/task-48-scenario-{N}.log`

  **Must NOT do**: No full Spring Batch DSL testing, no observability exporter testing.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: 10 scenarios is heavy, careful setup/teardown

  **Parallelization**:
  - **Can Run In Parallel**: NO (DB state, sequential scenarios)
  - **Parallel Group**: Wave 8 (final impl)
  - **Blocks**: F1-F4
  - **Blocked By**: 41-47, 37, 38

  **References**:
  - Metis: "10 E2E test scenarios" (detailed in plan)
  - User: All decisions (PostgreSQL :5434, MikroORM, REST, CSV fixtures)

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @nest-batch/demo test:e2e` → 10/10 pass
  - [ ] All evidence files exist in `.omo/evidence/`
  - [ ] Total runtime < 5 minutes
  - [ ] Each scenario is independent (DB reset between)

  **QA Scenarios**:
  ```
  Scenario: All 10 E2E scenarios pass
    Tool: Bash (vitest + supertest + real DB)
    Steps:
      1. docker compose up -d postgres
      2. pnpm --filter @nest-batch/demo migration:up
      3. pnpm --filter @nest-batch/demo test:e2e
    Expected: exit 0, "10 passed"
    Evidence: .omo/evidence/task-48-e2e-all.log (10 sub-files)
  ```

  **Commit**: YES
  - Message: `test(demo): add 10 E2E scenarios (happy, skip, retry, restart, concurrent, flow, malformed, listener failure)`
  - Files: `apps/demo/tests/e2e/*.spec.ts`, `vitest.e2e.config.ts`, `package.json` (scripts)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check `.omo/evidence/` files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm -r build` (swc) + `pnpm -r lint` + `pnpm -r test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, AI slop (excessive comments, over-abstraction, generic names).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute all 10 E2E scenarios from scratch: docker compose up, pnpm install, pnpm build, run demo, curl, supertest, restart simulation. Save evidence to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/10 pass] | Restart [PASS/FAIL] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do" vs actual `git diff`. Verify 1:1 — nothing missing, nothing beyond spec. Check "Must NOT Have" compliance (no scheduling, no dashboard, no partitioning, etc.). Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Must NOT [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

> Per task or per Milestone boundary. Format: `type(scope): desc` (Conventional Commits).

- **Wave 1**: `chore(monorepo): scaffold pnpm workspace` (root) + `feat(core): ir types & enums` + `feat(core): repo & tx abstract class` + `feat(core): execution context serializer` + `feat(core): definition validator`
- **Wave 2-3**: `feat(core): registry & explorer` + `feat(decorators): job/step/tasklet decorators` + `feat(decorators): item & listener decorators` + `feat(module): nest batch module` + `feat(repo): in-memory adapter` + `feat(builder): fluent builder API` + `feat(exec): step & job launcher` + `feat(exec): listener invoker`
- **Wave 4**: `feat(policy): skip & retry policies` + `feat(exec): chunk processor with failure semantics` + `feat(listener): 7 listener implementations`
- **Wave 5**: `feat(flow): transition definition & async evaluator` + `feat(builder): flow extensions` + `feat(decorators): flow decorators`
- **Wave 6-7**: `chore(demo): nest + mikroorm + postgres scaffold` + `feat(demo): mikroorm adapter` + `feat(demo): job instance identity & restart` + `feat(demo): concurrency control`
- **Wave 8**: `feat(demo): product entity & csv fixtures` + `feat(demo): csv reader & processor & writer` + `feat(demo): import-products job` + `feat(demo): listeners & rest endpoint` + `test(demo): 10 e2e scenarios`

---

## Success Criteria

### Verification Commands
```bash
# Install
pnpm install                                                  # Expected: success

# Build all packages
pnpm -r build                                                 # Expected: dist/ for both packages

# Unit + integration tests
pnpm -r test                                                  # Expected: all green, TDD evidence

# Lint
pnpm -r lint                                                  # Expected: 0 errors

# Start DB
docker compose up -d postgres                                 # Expected: postgres :5434 ready

# Demo build + start
pnpm --filter @nest-batch/demo build                          # Expected: dist/
pnpm --filter @nest-batch/demo start:dev                      # Expected: Nest listens on :3000

# E2E happy path
curl -X POST http://localhost:3000/jobs/import-products \
  -H "Content-Type: application/json" \
  -d '{"file":"sample-data/products-valid.csv"}'              # Expected: 200, status COMPLETED, 3 products

# E2E skip path
curl -X POST http://localhost:3000/jobs/import-products \
  -d '{"file":"sample-data/products-with-errors.csv"}'        # Expected: COMPLETED, skip count 3, valid rows inserted

# E2E restart
pnpm --filter @nest-batch/demo test:e2e -- scenarios/restart  # Expected: PASS, no duplicate products
```

### Final Checklist
- [x] All "Must Have" implemented and verified
- [x] All "Must NOT Have" absent (verified via grep)
- [x] TDD commit history shows RED→GREEN→REFACTOR per behavior
- [x] All 10 E2E scenarios pass
- [x] Two API parity test passes (decorator + builder → same IR)
- [x] InMemoryJobRepository is real repo (deterministic IDs, deep clone, uniqueness)
- [x] MikroORM adapter implements all JobRepository abstract methods
- [x] Restart simulation does not duplicate already-committed products
- [x] Concurrent launch of same job+params is rejected deterministically
- [x] All 40+ tasks committed, no unaccounted files
