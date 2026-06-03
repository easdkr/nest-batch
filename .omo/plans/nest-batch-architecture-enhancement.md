# nest-batch Architecture Enhancement Work Plan

## TL;DR

> **Quick Summary**: Evolve `nest-batch` into a Spring Batch-like `@nest-batch/*` package family with a lightweight NestJS-coupled core, DB-first durable repositories, BullMQ transport/scheduling, Redis local development, and cron-based decorators.
>
> **Deliverables**:
> - Correctness foundations: CI, listener wiring, `ProviderToken` resolution, restart support, shared contract tests.
> - Package family: `@nest-batch/core`, `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/bullmq`.
> - Runtime model: polymorphic `JobLauncher` backed by injectable execution strategies; DB remains source of truth, BullMQ is execution runtime for step/partition distribution.
> - Developer ergonomics: Spring Batch-like cron decorators, local Redis setup, package READMEs, migration notes.
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES - 4 implementation waves + final verification
> **Critical Path**: CI + contract tests → listener/ref correctness → package split → ORM adapters → BullMQ strategy + cron → demo e2e → F1-F4

---

## Context

### Original Request
The user asked to enhance this package using BullMQ for Spring Batch-like behavior, Redis in local development, adapterization so alternatives to BullMQ can be used later, NestJS decorator-style cron scheduling, and sibling packages for integrations such as MikroORM, TypeORM 1.0.0, Drizzle, and BullMQ.

### Interview Summary
**Key Discussions**:
- New long-term architecture is prioritized over preserving the current API exactly.
- Core should stay lightweight and NestJS-coupled; runtime integrations move into sibling packages.
- BullMQ is not the batch engine; it is transport/worker/scheduler runtime only, and DB/ORM repositories remain durable source of truth.
- Batch Core owns Job/Step/Reader/Processor/Writer semantics plus checkpoint, restart, skip, chunk transaction, and business retry.
- BullMQ is used for worker distribution, partition parallelization, technical retry/backoff, rate limit, and optional scheduling.
- BullMQ jobs are step-level or partition-level units, never row/item-level jobs.
- Local BullMQ development uses Redis.
- Cron scheduling uses a library-owned Spring Batch-like abstraction over `cron`.
- Adapter packages own batch meta entities/schema/migrations/reference schema.
- Public launch API becomes a polymorphic `JobLauncher` using injectable execution strategies.
- Test strategy is TDD.
- Package scope is `@nest-batch/*`.
- TypeORM adapter targets TypeORM 1.0.0 only.
- Drizzle is explicitly excluded from this plan.

**Research Findings**:
- Existing code already has important seams: `IJobRepository` / `JobRepository`, `TransactionManager`, `JobLauncher`, `JobExecutor`, `JobRegistry`, decorators, builders, and demo-level MikroORM implementations.
- Major current gaps: empty listener resolver map, incomplete `ProviderToken` resolution, tasklet runtime limited to `BuilderLambda`, `MikroORMJobRepository.findLatestStepExecution()` stub, absent CI.
- Vitest infrastructure is mature; library tests are extensive enough to support TDD and contract-test-first refactoring.
- Sibling packages with hard peer dependencies are preferred over lazy optional `require()` patterns.
- BullMQ adapter should use Queue/Worker/FlowProducer/QueueEvents, close gracefully, keep Redis producer/worker connection policies explicit, and invoke Batch Core for all batch semantics.

### Metis Review
**Identified Gaps** (addressed):
- Migration story: use a breaking new major-structure release with migration docs/tests; no dual-API or codemod in scope.
- Versioning: use lockstep versions across initial `@nest-batch/*` release.
- NestJS baseline: support Nest 10 + 11 unless TDD setup proves otherwise.
- Strategy resolution: use explicit Nest injection tokens/interfaces for execution strategy.
- Contract definition: encode repository/job state machine semantics in shared contract tests before adapters.
- Scope guardrails: no admin UI, metrics implementation, tracing implementation, alternative transports, Drizzle, auth, webhook, or job visualization work.

### Oracle Phase-1 Review
**CHECK 5/5 PASS | VERDICT: GO**
- Objective, scope, test strategy, open questions, and codebase consistency were verified.
- Housekeeping was applied to the draft: explicit objective added, stale pending markers resolved, CodeGraph status corrected.

---

## Work Objectives

### Core Objective
Implement a TDD-first package architecture upgrade that stabilizes current correctness gaps, extracts `@nest-batch/*` sibling packages, and adds BullMQ/cron integration while preserving DB-first durable execution semantics.

### Concrete Deliverables
- `.github/workflows/ci.yml` for build/lint/typecheck/test gates.
- Shared adapter contract tests for repositories, transactions, launch strategies, and package dependency boundaries.
- Listener resolver and `ProviderToken` correctness fixes in `@nest-batch/core`.
- `findLatestStepExecution` support for MikroORM persistence.
- Core strategy interfaces/tokens for polymorphic `JobLauncher`.
- Package split into `@nest-batch/core`, `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/bullmq`.
- BullMQ adapter module with Redis local development wiring, Queue/Worker/FlowProducer/QueueEvents lifecycle, and DB-first execution-state integration.
- Spring Batch-like cron decorator API backed by `cron`.
- Demo app migrated to use sibling packages and BullMQ transport path.
- READMEs/migration docs for the new package family.

### Definition of Done
- [ ] `pnpm install --frozen-lockfile` passes on a clean clone.
- [ ] `pnpm -r build` passes for every workspace package.
- [ ] `pnpm typecheck` passes with strict TypeScript.
- [ ] `pnpm -r lint` passes with no new restricted-import violations.
- [ ] `pnpm test` passes all unit, contract, and e2e tests.
- [ ] Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories.
- [ ] Package exports and peer dependency boundaries match the scope rules.

### Must Have
- TDD: each implementation task starts with failing tests or failing contract/API checks.
- `@nest-batch/core` remains dependency-light and does not import BullMQ, MikroORM, TypeORM, Drizzle, or `cron` implementation packages.
- ORM adapter packages own batch metadata schema/migration artifacts.
- BullMQ is transport/scheduler only; DB/ORM repository is durable source of truth.
- BullMQ is not a batch engine; Batch Core owns Job/Step/Reader/Processor/Writer, checkpoint, restart, skip, chunk transaction, and business retry semantics.
- BullMQ jobs are created only for step or partition execution units, not per row/item.
- BullMQ handles technical/runtime retry/backoff, rate limiting, worker distribution, partition parallelization, and optional scheduling.
- `JobLauncher` remains the main public launch API and becomes strategy-backed/polymorphic.
- TypeORM adapter targets TypeORM 1.0.0 only.
- Drizzle is not implemented or scaffolded in this plan.

### Must NOT Have (Guardrails)
- No `@nest-batch/drizzle` work.
- No admin UI, metrics backend, tracing backend, webhook system, auth, job visualization, alternate queue transports, or multi-tenant routing.
- No lazy optional `require()` pattern in core or sibling packages.
- No cross-imports between transport and ORM packages except through `@nest-batch/core` interfaces.
- No row-per-BullMQ-job implementation.
- No moving checkpoint/restart/chunk transaction/business skip-retry logic into BullMQ processors.
- No `any`/`@ts-ignore` in exported public APIs.
- No acceptance criteria requiring human manual testing.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD
- **Framework**: Vitest + existing e2e setup
- **If TDD**: Each task follows RED (failing test/contract/API snapshot) → GREEN (minimal implementation) → REFACTOR.

### QA Policy
Every task includes agent-executed QA scenarios. Evidence must be saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Backend/package**: Bash commands (`pnpm --filter ... test`, `pnpm --filter ... build`, `pnpm typecheck`).
- **API/demo**: Bash `curl` against local Nest app where applicable.
- **Redis/BullMQ**: Bash + docker compose + Node/Vitest e2e output.
- **Documentation/package exports**: Bash `pnpm pack --dry-run`, import smoke tests, and file existence checks.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation + failing guards, can start immediately):
├── Task 1: CI workflow + package gate baseline [quick]
├── Task 2: Dependency boundary and public API snapshot tests [quick]
├── Task 3: Shared repository/transaction contract tests [unspecified-high]
├── Task 4: Failing listener resolver tests [quick]
├── Task 5: Failing ProviderToken/runtime-ref tests [quick]
├── Task 6: Failing restart/checkpoint tests for MikroORM [unspecified-high]
└── Task 7: Strategy-backed JobLauncher contract tests [unspecified-high]

Wave 2 (Core correctness + strategy implementation):
├── Task 8: Listener resolver wiring + listener API consolidation (depends: 4) [deep]
├── Task 9: ProviderToken resolver implementation (depends: 5) [deep]
├── Task 10: MikroORM findLatestStepExecution + checkpoint correctness (depends: 6) [unspecified-high]
├── Task 11: ExecutionStrategy abstraction + polymorphic JobLauncher (depends: 7) [deep]
├── Task 12: Core tokens/options/package-boundary hardening (depends: 2, 3, 11) [unspecified-high]
└── Task 13: Spring Batch-like cron decorator API contract (depends: 2) [unspecified-high]

Wave 3 (Sibling packages, parallel after core contracts stabilize):
├── Task 14: Rename/extract @nest-batch/core package layout (depends: 12) [unspecified-high]
├── Task 15: Extract @nest-batch/mikro-orm package (depends: 3, 10, 14) [unspecified-high]
├── Task 16: Implement @nest-batch/typeorm package for TypeORM 1.0.0 (depends: 3, 14) [unspecified-high]
├── Task 17: Implement @nest-batch/bullmq package skeleton and Redis local setup (depends: 11, 14) [deep]
├── Task 18: Implement BullMQ step/partition runtime bridge and DB-first state bridge (depends: 17) [deep]
└── Task 19: Package READMEs and migration notes (depends: 14-18) [writing]

Wave 4 (Integration + demo proof):
├── Task 20: Demo app migration to package imports and strategy-backed launcher (depends: 15, 16, 18) [unspecified-high]
├── Task 21: Redis + DB e2e BullMQ execution path (depends: 18, 20) [deep]
├── Task 22: Cron decorator e2e and overlap/timezone behavior (depends: 13, 18, 20) [unspecified-high]
├── Task 23: Package dry-run and peer dependency validation (depends: 14-19) [quick]
└── Task 24: Final docs/examples sweep (depends: 19-23) [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan Compliance Audit (oracle)
├── F2: Code Quality Review (unspecified-high)
├── F3: Real Manual QA (unspecified-high)
└── F4: Scope Fidelity Check (deep)
```

### Dependency Matrix

- **1**: blocks 23, F2; blocked by none; wave 1.
- **2**: blocks 12, 13, 23; blocked by none; wave 1.
- **3**: blocks 12, 15, 16; blocked by none; wave 1.
- **4**: blocks 8; blocked by none; wave 1.
- **5**: blocks 9; blocked by none; wave 1.
- **6**: blocks 10; blocked by none; wave 1.
- **7**: blocks 11; blocked by none; wave 1.
- **8**: blocks 18, 22; blocked by 4; wave 2.
- **9**: blocks 18, 20; blocked by 5; wave 2.
- **10**: blocks 15, 20, 21; blocked by 6; wave 2.
- **11**: blocks 12, 17, 20; blocked by 7; wave 2.
- **12**: blocks 14, 15, 16; blocked by 2, 3, 11; wave 2.
- **13**: blocks 22; blocked by 2; wave 2.
- **14**: blocks 15, 16, 17, 19, 23; blocked by 12; wave 3.
- **15**: blocks 20, 21; blocked by 3, 10, 14; wave 3.
- **16**: blocks 20, 23; blocked by 3, 14; wave 3.
- **17**: blocks 18; blocked by 11, 14; wave 3.
- **18**: blocks 20, 21, 22; blocked by 17, 8, 9; wave 3; enforces step/partition granularity and row-level job prohibition.
- **19**: blocks 24; blocked by 14, 15, 16, 17, 18; wave 3.
- **20**: blocks 21, 22, 24; blocked by 15, 16, 18, 11; wave 4.
- **21**: blocks 24; blocked by 18, 20, 10; wave 4.
- **22**: blocks 24; blocked by 13, 18, 20; wave 4.
- **23**: blocks 24; blocked by 1, 2, 14-19; wave 4.
- **24**: blocks F1-F4; blocked by 19-23; wave 4.

### Agent Dispatch Summary

- **Wave 1**: 7 tasks — 1/2/4/5 `quick`, 3/6/7 `unspecified-high`.
- **Wave 2**: 6 tasks — 8/9/11 `deep`, 10/12/13 `unspecified-high`.
- **Wave 3**: 6 tasks — 14/15/16 `unspecified-high`, 17/18 `deep`, 19 `writing`.
- **Wave 4**: 5 tasks — 20 `unspecified-high`, 21 `deep`, 22 `unspecified-high`, 23 `quick`, 24 `writing`.
- **FINAL**: 4 review tasks — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`.

---

## TODOs

> Implementation + Test = ONE Task. Every task must capture evidence.

- [x] 1. Add CI workflow and baseline quality gate

  **What to do**:
  - RED: create/verify a failing CI-equivalent local command sequence if current repo lacks workflow coverage.
  - Add `.github/workflows/ci.yml` for Node/pnpm setup, install, build, lint, typecheck, and test.
  - Keep CI minimal first: one Node version matching repo constraints, no matrix until packages are stable.

  **Must NOT do**:
  - Do not add deployment, release, publish, Docker registry, or matrix complexity.

  **Recommended Agent Profile**:
  - **Category**: `quick` - mechanical workflow/config task.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `deploy-status` - no deployment status is being checked.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 23, F2
  - **Blocked By**: None

  **References**:
  - `package.json` - root scripts for `build`, `test`, `lint`, `typecheck`, `format:check`.
  - `pnpm-workspace.yaml` - workspace package discovery.
  - `README.md` - documented Node/pnpm/tooling expectations.
  - `.gitignore` - existing coverage/cache conventions.

  **Acceptance Criteria**:
  - [ ] `.github/workflows/ci.yml` exists and runs install/build/lint/typecheck/test.
  - [ ] `pnpm install --frozen-lockfile` command is represented in workflow.
  - [ ] Local equivalent `pnpm build && pnpm lint && pnpm typecheck && pnpm test` passes.

  **QA Scenarios**:
  ```
  Scenario: CI local command succeeds
    Tool: Bash
    Preconditions: Clean checkout with dependencies installed or installable via pnpm.
    Steps:
      1. Run `pnpm build`.
      2. Run `pnpm lint`.
      3. Run `pnpm typecheck`.
      4. Run `pnpm test`.
    Expected Result: All commands exit 0.
    Failure Indicators: Any command exits non-zero or workflow omits one quality gate.
    Evidence: .omo/evidence/task-1-ci-local.txt

  Scenario: Workflow is intentionally minimal
    Tool: Bash
    Preconditions: `.github/workflows/ci.yml` exists.
    Steps:
      1. Parse workflow text for `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
      2. Assert no deploy/publish/release step exists.
    Expected Result: Required gates present; release/deploy absent.
    Evidence: .omo/evidence/task-1-ci-workflow.txt
  ```

  **Commit**: YES
  - Message: `ci: add package quality workflow`
  - Files: `.github/workflows/ci.yml`
  - Pre-commit: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`

- [x] 2. Add dependency-boundary and public API snapshot tests

  **What to do**:
  - RED: add tests/rules that fail if `@nest-batch/core` imports BullMQ, MikroORM, TypeORM, Drizzle, or cron implementation packages.
  - Add public API snapshot or import-smoke tests for root exports.
  - Add restricted import rules suitable for future sibling packages.

  **Must NOT do**:
  - Do not alter runtime behavior.

  **Recommended Agent Profile**:
  - **Category**: `quick` - test/rule scaffolding with narrow scope.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `test-driven-development` - plan already mandates TDD; executor may load it if available.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 12, 13, 23
  - **Blocked By**: None

  **References**:
  - `packages/nest-batch/src/index.ts` - current public export surface.
  - `packages/nest-batch/package.json` - current package name and dependencies.
  - `eslint.config.*` or root lint config - add restricted-import checks where conventions live.

  **Acceptance Criteria**:
  - [ ] A failing test/rule catches forbidden core imports.
  - [ ] Import-smoke test validates public exports compile.
  - [ ] `pnpm lint` and `pnpm --filter @nest-batch/core test` pass after implementation.

  **QA Scenarios**:
  ```
  Scenario: Core forbidden imports are rejected
    Tool: Bash
    Preconditions: Boundary rule/test exists.
    Steps:
      1. Run the boundary test command documented by the executor.
      2. Verify it passes with current code.
      3. Inspect evidence showing forbidden packages list includes bullmq, mikro-orm, typeorm, drizzle, cron implementation packages.
    Expected Result: Boundary test exits 0 and protects core dependency-light promise.
    Evidence: .omo/evidence/task-2-boundary.txt

  Scenario: Public API import smoke succeeds
    Tool: Bash
    Preconditions: Public API test exists.
    Steps:
      1. Run `pnpm --filter @nest-batch/core test` or equivalent single test.
      2. Assert imports from `@nest-batch/core` compile and execute no-op checks.
    Expected Result: Import smoke passes.
    Evidence: .omo/evidence/task-2-api-smoke.txt
  ```

  **Commit**: YES
  - Message: `test(core): guard public api and dependencies`
  - Files: test/rule files only
  - Pre-commit: `pnpm lint && pnpm --filter @nest-batch/core test`

- [x] 3. Create shared repository and transaction contract tests

  **What to do**:
  - RED: extract current repository contract expectations into reusable contract helpers.
  - Cover `getOrCreateJobInstance`, `createExecutionAtomic`, status updates, contexts, step execution lookup, restart checkpoint behavior, and transaction wrapping.
  - Make the contract runnable against in-memory, MikroORM, and later TypeORM implementations.

  **Must NOT do**:
  - Do not couple contract tests to one ORM's entity classes.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - multi-file tests and abstraction design.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `db-migrate` - no migration generation yet.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 12, 15, 16
  - **Blocked By**: None

  **References**:
  - `packages/nest-batch/src/core/repository/job-repository.ts` - 10-method contract.
  - `packages/nest-batch/src/core/transaction/transaction-manager.ts` - transaction contract.
  - `packages/nest-batch/tests/core/repository/contract.test.ts` - existing contract coverage.
  - `packages/nest-batch/src/repository/in-memory/in-memory-job-repository.ts` - default implementation.

  **Acceptance Criteria**:
  - [ ] Shared contract helper exists and is reusable by future packages.
  - [ ] In-memory implementation passes the extracted contract suite.
  - [ ] Contract includes negative/concurrency/restart checkpoint cases.

  **QA Scenarios**:
  ```
  Scenario: In-memory repository passes shared contract
    Tool: Bash
    Preconditions: Shared contract test is wired to in-memory repository.
    Steps:
      1. Run `pnpm --filter @nest-batch/core test -- contract` or executor-documented equivalent.
      2. Assert all repository and transaction contract cases pass.
    Expected Result: 0 failures; evidence lists contract cases.
    Evidence: .omo/evidence/task-3-contract-inmemory.txt

  Scenario: Contract catches missing checkpoint lookup
    Tool: Bash
    Preconditions: Contract contains restart checkpoint case.
    Steps:
      1. Run contract test against current/stub implementation before fix if possible.
      2. Capture failing assertion for `findLatestStepExecution` behavior or prove the test would fail against a stub fake.
    Expected Result: Test detects null/stub checkpoint lookup.
    Evidence: .omo/evidence/task-3-contract-negative.txt
  ```

  **Commit**: YES
  - Message: `test(core): extract repository contract suite`
  - Files: `packages/nest-batch/tests/**`
  - Pre-commit: `pnpm --filter @nest-batch/core test`

- [x] 4. Add failing listener resolver tests

  **What to do**:
  - RED: prove `@BeforeJob`, `@AfterJob`, `@BeforeStep`, `@AfterStep`, and error/skip listeners are discovered but not invoked today.
  - Cover both builder-defined and decorator-discovered jobs.
  - Record expected unified resolver key shape.

  **Must NOT do**:
  - Do not implement resolver logic in this task.

  **Recommended Agent Profile**:
  - **Category**: `quick` - failing tests only.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8
  - **Blocked By**: None

  **References**:
  - `packages/nest-batch/src/execution/job-executor.ts:buildResolverMap` - currently empty resolver map.
  - `packages/nest-batch/src/execution/listener-invoker.ts` - legacy/current listener APIs.
  - `packages/nest-batch/src/decorators/listener.decorators.ts` - listener metadata definitions.
  - `packages/nest-batch/tests/execution/listener-*.test.ts` - existing listener expectations.

  **Acceptance Criteria**:
  - [ ] Tests fail before implementation because listeners are not invoked.
  - [ ] Tests define expected behavior for non-critical listener failure.
  - [ ] Tests define expected behavior for critical listener failure.

  **QA Scenarios**:
  ```
  Scenario: Listener test red state captured
    Tool: Bash
    Preconditions: Failing listener resolver tests are added.
    Steps:
      1. Run the new listener test before implementation or capture git diff/test output showing RED.
      2. Assert failure message says expected listener spy call count differs from actual.
    Expected Result: RED state is explicit and attributable to missing resolver wiring.
    Evidence: .omo/evidence/task-4-listener-red.txt

  Scenario: Test coverage includes negative listener failure
    Tool: Bash
    Preconditions: Failing tests exist.
    Steps:
      1. Inspect test names/output for critical listener throws and non-critical listener throws.
      2. Assert both behaviors are represented.
    Expected Result: Both failure modes are captured.
    Evidence: .omo/evidence/task-4-listener-negative.txt
  ```

  **Commit**: NO
  - Message: grouped with Task 8 implementation
  - Files: listener tests
  - Pre-commit: N/A

- [x] 5. Add failing ProviderToken and runtime-ref tests

  **What to do**:
  - RED: add tests showing `RefKind.ProviderToken` can express reader/processor/writer/tasklet/listener refs but currently fails at runtime.
  - Define resolver expectations through Nest DI / provider token lookup.
  - Include failure behavior for missing provider token.

  **Must NOT do**:
  - Do not implement resolver logic in this task.

  **Recommended Agent Profile**:
  - **Category**: `quick` - failing tests only.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 9
  - **Blocked By**: None

  **References**:
  - `packages/nest-batch/src/core/ir/refs.ts` - `RefKind.ProviderToken` definition.
  - `packages/nest-batch/src/execution/chunk-step-executor.ts` - current reader/processor/writer resolver branches.
  - `packages/nest-batch/src/execution/tasklet-step-executor.ts` - tasklet resolver limitation.
  - `packages/nest-batch/src/compiler/definition-compiler.ts` - current ref emission behavior.

  **Acceptance Criteria**:
  - [ ] Tests fail before implementation for ProviderToken reader/writer/tasklet/listener refs.
  - [ ] Tests specify missing token error behavior.
  - [ ] Tests specify Nest provider lookup must use singleton provider instance.

  **QA Scenarios**:
  ```
  Scenario: ProviderToken test red state captured
    Tool: Bash
    Preconditions: Failing ProviderToken tests are added.
    Steps:
      1. Run the new ProviderToken tests before implementation.
      2. Capture failure indicating unsupported ProviderToken resolution.
    Expected Result: RED state is explicit and not caused by unrelated failures.
    Evidence: .omo/evidence/task-5-provider-token-red.txt

  Scenario: Missing provider token negative case exists
    Tool: Bash
    Preconditions: ProviderToken tests exist.
    Steps:
      1. Inspect test output or test file names for missing token case.
      2. Assert expected error is deterministic and user-facing.
    Expected Result: Missing provider behavior is specified.
    Evidence: .omo/evidence/task-5-provider-token-negative.txt
  ```

  **Commit**: NO
  - Message: grouped with Task 9 implementation
  - Files: runtime-ref tests
  - Pre-commit: N/A

- [x] 6. Add failing MikroORM restart and checkpoint tests

  **What to do**:
  - RED: add/extend MikroORM adapter tests proving `findLatestStepExecution` must return the latest execution for restart/checkpoint resume.
  - Cover completed and failed step cases, multiple executions, and correct ordering.
  - Include a negative test for no matching step.

  **Must NOT do**:
  - Do not implement MikroORM query in this task.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - e2e/DB test design.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `db-migrate` - no migration generation yet.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 10
  - **Blocked By**: None

  **References**:
  - `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts` - current stub.
  - `apps/demo/src/entities/job-meta.entities.ts` - step execution entity shape.
  - `apps/demo/tests/e2e/import-products.e2e.spec.ts` - live DB e2e patterns.
  - `packages/nest-batch/src/execution/job-executor.ts` - restart checkpoint lookup.

  **Acceptance Criteria**:
  - [ ] Failing test captures current stub behavior.
  - [ ] Test asserts latest matching step execution by job execution + step id.
  - [ ] Test asserts `null` only when no matching step exists.

  **QA Scenarios**:
  ```
  Scenario: MikroORM restart red state captured
    Tool: Bash
    Preconditions: PostgreSQL test DB available per demo e2e setup.
    Steps:
      1. Run the new e2e/adapter test before implementation.
      2. Capture failure showing `findLatestStepExecution` returned null despite existing rows.
    Expected Result: RED failure is specific to checkpoint lookup.
    Evidence: .omo/evidence/task-6-mikro-restart-red.txt

  Scenario: No matching step returns null
    Tool: Bash
    Preconditions: Test DB contains job execution with different step id.
    Steps:
      1. Run negative lookup test.
      2. Assert returned value is null.
    Expected Result: Null only for genuinely absent matching step.
    Evidence: .omo/evidence/task-6-mikro-restart-negative.txt
  ```

  **Commit**: NO
  - Message: grouped with Task 10 implementation
  - Files: MikroORM adapter/e2e tests
  - Pre-commit: N/A

- [x] 7. Add failing polymorphic JobLauncher strategy contract tests

  **What to do**:
  - RED: define `ExecutionStrategy` or equivalent token contract consumed by `JobLauncher`.
  - Add tests for in-process strategy behavior preserving current synchronous semantics.
  - Add fake queue strategy tests proving `JobLauncher.launch()` can delegate transport without changing controller-level API.

  **Must NOT do**:
  - Do not add BullMQ dependency in core.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - API contract tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 11
  - **Blocked By**: None

  **References**:
  - `packages/nest-batch/src/execution/job-launcher.ts` - current launch/run behavior.
  - `packages/nest-batch/src/execution/job-executor.ts` - current execution target.
  - `apps/demo/src/controller/batch.controller.ts` - public consumer of `JobLauncher`.
  - `packages/nest-batch/tests/execution/job-launcher.test.ts` - existing launcher tests.

  **Acceptance Criteria**:
  - [ ] Failing tests specify in-process and fake-transport strategy behavior.
  - [ ] Core tests prove no BullMQ import is required.
  - [ ] Controller-facing API remains `JobLauncher.launch(jobId, params)`.

  **QA Scenarios**:
  ```
  Scenario: Strategy contract red state captured
    Tool: Bash
    Preconditions: Strategy contract tests are added.
    Steps:
      1. Run new job launcher tests before implementation.
      2. Capture failure showing launcher does not accept/inject execution strategy yet.
    Expected Result: RED state is attributable to missing strategy abstraction.
    Evidence: .omo/evidence/task-7-launcher-strategy-red.txt

  Scenario: Core stays BullMQ-free
    Tool: Bash
    Preconditions: Boundary test from Task 2 exists.
    Steps:
      1. Run core dependency boundary test.
      2. Assert no `bullmq` import appears in core strategy tests/implementation.
    Expected Result: Boundary passes.
    Evidence: .omo/evidence/task-7-core-no-bullmq.txt
  ```

  **Commit**: NO
  - Message: grouped with Task 11 implementation
  - Files: launcher strategy tests
  - Pre-commit: N/A

- [x] 8. Implement listener resolver wiring and consolidate listener API

  **What to do**:
  - GREEN for Task 4 tests.
  - Build resolver map from discovered/compiled job and step listener definitions.
  - Consolidate legacy and current listener invocation paths into one public internal API.
  - Preserve non-critical listener behavior and critical failure behavior.

  **Must NOT do**:
  - Do not change listener decorator names unless required by tests.
  - Do not add observability backends.

  **Recommended Agent Profile**:
  - **Category**: `deep` - central execution path and compatibility risk.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after Wave 1
  - **Parallel Group**: Wave 2
  - **Blocks**: 18, 22
  - **Blocked By**: 4

  **References**:
  - `packages/nest-batch/src/execution/job-executor.ts:buildResolverMap` - target implementation point.
  - `packages/nest-batch/src/execution/listener-invoker.ts` - consolidation target.
  - `packages/nest-batch/src/explorer/batch-explorer.ts` - discovered listener source.
  - `packages/nest-batch/src/core/ir/listener-definition.ts` - listener IR contract.

  **Acceptance Criteria**:
  - [ ] Task 4 tests now pass.
  - [ ] Existing listener tests pass.
  - [ ] No duplicate listener invocation occurs.
  - [ ] Critical listener failure changes execution outcome as specified by tests.
  - [ ] Non-critical listener failure is logged/contained as specified by tests.

  **QA Scenarios**:
  ```
  Scenario: Decorated listeners fire in order
    Tool: Bash
    Preconditions: Listener resolver implementation exists.
    Steps:
      1. Run `pnpm --filter @nest-batch/core test -- listener`.
      2. Assert test output includes before/after listener ordering cases passing.
    Expected Result: Listener spies called exactly once in expected order.
    Evidence: .omo/evidence/task-8-listener-order.txt

  Scenario: Critical listener failure fails safely
    Tool: Bash
    Preconditions: Critical listener failure test exists.
    Steps:
      1. Run the critical failure listener test.
      2. Assert execution status/error behavior matches contract.
    Expected Result: Critical listener failure is not swallowed silently.
    Evidence: .omo/evidence/task-8-listener-critical.txt
  ```

  **Commit**: YES
  - Message: `fix(core): wire listener resolvers`
  - Files: `packages/nest-batch/src/execution/**`, listener tests
  - Pre-commit: `pnpm --filter @nest-batch/core test`

- [x] 9. Implement ProviderToken and runtime ref resolution

  **What to do**:
  - GREEN for Task 5 tests.
  - Add resolver abstraction for `BuilderLambda`, `Method`, and `ProviderToken` refs.
  - Support reader/processor/writer/tasklet/listener runtime lookup through Nest provider tokens.
  - Emit deterministic user-facing errors for missing tokens or wrong handler shape.

  **Must NOT do**:
  - Do not introduce transport/ORM-specific logic into core resolver.

  **Recommended Agent Profile**:
  - **Category**: `deep` - central runtime resolution design.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after Wave 1
  - **Parallel Group**: Wave 2
  - **Blocks**: 18, 20
  - **Blocked By**: 5

  **References**:
  - `packages/nest-batch/src/core/ir/refs.ts` - ref kinds.
  - `packages/nest-batch/src/execution/chunk-step-executor.ts` - reader/processor/writer resolution.
  - `packages/nest-batch/src/execution/tasklet-step-executor.ts` - tasklet resolution.
  - `packages/nest-batch/src/module/nest-batch.module.ts` - DI/bootstrap context.

  **Acceptance Criteria**:
  - [ ] Task 5 tests pass.
  - [ ] ProviderToken refs work for tasklet and chunk handlers.
  - [ ] Missing token produces clear `BatchError` or documented error type.
  - [ ] Core dependency boundary tests still pass.

  **QA Scenarios**:
  ```
  Scenario: ProviderToken tasklet executes
    Tool: Bash
    Preconditions: ProviderToken resolver implemented.
    Steps:
      1. Run ProviderToken tasklet test.
      2. Assert tasklet provider method is called and job completes.
    Expected Result: Execution status COMPLETED with provider spy called once.
    Evidence: .omo/evidence/task-9-provider-tasklet.txt

  Scenario: Missing ProviderToken fails clearly
    Tool: Bash
    Preconditions: Missing token test exists.
    Steps:
      1. Run missing token test.
      2. Assert error message includes token and handler role.
    Expected Result: Deterministic error; no null dereference.
    Evidence: .omo/evidence/task-9-provider-missing.txt
  ```

  **Commit**: YES
  - Message: `feat(core): resolve provider token refs`
  - Files: `packages/nest-batch/src/core/**`, `packages/nest-batch/src/execution/**`, tests
  - Pre-commit: `pnpm --filter @nest-batch/core test`

- [x] 10. Implement MikroORM checkpoint lookup and restart correctness

  **What to do**:
  - GREEN for Task 6 tests.
  - Implement `findLatestStepExecution` in MikroORM repository using job execution id + step id ordering.
  - Ensure execution context checkpoint lookup uses returned step execution correctly.
  - Preserve DB-first durable semantics.

  **Must NOT do**:
  - Do not move MikroORM adapter into a package yet.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - DB query/e2e correctness.
  - **Skills**: [`db-migrate`]
  - **Skills Evaluated but Omitted**: none if migration not needed; executor may omit `db-migrate` if query-only.

  **Parallelization**:
  - **Can Run In Parallel**: YES after Wave 1
  - **Parallel Group**: Wave 2
  - **Blocks**: 15, 20, 21
  - **Blocked By**: 6

  **References**:
  - `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts` - implementation target.
  - `apps/demo/src/entities/job-meta.entities.ts` - DB fields and relationships.
  - `packages/nest-batch/src/core/repository/job-repository.ts` - contract method semantics.
  - `packages/nest-batch/src/execution/job-executor.ts` - restart use site.

  **Acceptance Criteria**:
  - [ ] Task 6 tests pass.
  - [ ] Contract test for restart/checkpoint passes against MikroORM.
  - [ ] No migration is added unless required by tests.
  - [ ] Existing demo e2e still passes.

  **QA Scenarios**:
  ```
  Scenario: Latest step execution is returned
    Tool: Bash
    Preconditions: PostgreSQL test DB available.
    Steps:
      1. Run MikroORM checkpoint test.
      2. Assert latest matching step execution id is returned, not older row.
    Expected Result: Latest row returned deterministically.
    Evidence: .omo/evidence/task-10-mikro-latest.txt

  Scenario: Restart resumes from checkpoint
    Tool: Bash
    Preconditions: Restart e2e fixture exists with saved `lastChunkIndex`.
    Steps:
      1. Run restart/checkpoint e2e.
      2. Assert already-completed chunks are not written twice.
    Expected Result: No duplicate writes; execution completes from checkpoint.
    Evidence: .omo/evidence/task-10-mikro-restart.txt
  ```

  **Commit**: YES
  - Message: `fix(mikro-orm): restore checkpoint lookup`
  - Files: `apps/demo/src/adapters/mikroorm/**`, tests
  - Pre-commit: `pnpm --filter @nest-batch/demo test:e2e`

- [x] 11. Implement execution strategy abstraction and polymorphic JobLauncher

  **What to do**:
  - GREEN for Task 7 tests.
  - Introduce strategy interface/token for in-process execution and future BullMQ transport.
  - Refactor `JobLauncher` to delegate through strategy while preserving `launch(jobId, params)` API.
  - Keep current in-process behavior as default strategy.

  **Must NOT do**:
  - Do not import BullMQ in core.
  - Do not remove existing controller usage of `JobLauncher`.

  **Recommended Agent Profile**:
  - **Category**: `deep` - central public API refactor.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after Wave 1
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 17, 20
  - **Blocked By**: 7

  **References**:
  - `packages/nest-batch/src/execution/job-launcher.ts` - refactor target.
  - `packages/nest-batch/src/execution/job-executor.ts` - default in-process strategy target.
  - `packages/nest-batch/src/module/nest-batch.module.ts` - provider wiring.
  - `apps/demo/src/controller/batch.controller.ts` - public usage must keep working.

  **Acceptance Criteria**:
  - [ ] Task 7 tests pass.
  - [ ] Existing `JobLauncher` tests pass.
  - [ ] In-process launch semantics unchanged.
  - [ ] Fake queue strategy can return an execution/enqueue result through the same API.
  - [ ] Core boundary test proves no BullMQ import.

  **QA Scenarios**:
  ```
  Scenario: Existing in-process launch still completes
    Tool: Bash
    Preconditions: Default in-process strategy wired.
    Steps:
      1. Run `pnpm --filter @nest-batch/core test -- job-launcher`.
      2. Assert existing completion/status tests pass.
    Expected Result: No regression in current launch behavior.
    Evidence: .omo/evidence/task-11-launcher-inprocess.txt

  Scenario: Fake transport strategy delegates
    Tool: Bash
    Preconditions: Fake strategy test exists.
    Steps:
      1. Run strategy delegation test.
      2. Assert fake strategy spy is called with job definition and parameters.
    Expected Result: `JobLauncher` delegates without knowing transport implementation.
    Evidence: .omo/evidence/task-11-launcher-transport.txt
  ```

  **Commit**: YES
  - Message: `feat(core): add execution strategy launcher`
  - Files: `packages/nest-batch/src/execution/**`, `packages/nest-batch/src/module/**`, tests
  - Pre-commit: `pnpm --filter @nest-batch/core test`

- [x] 12. Harden core tokens, options, and package boundaries

  **What to do**:
  - Add explicit core injection tokens/interfaces for repository, transaction manager, execution strategy, schedule registry, and adapter options as needed.
  - Add `extraProviders`/module options support required by sibling packages.
  - Keep public exports stable or intentionally snapshot changes.
  - GREEN for Tasks 2 and 3 dependent tests.

  **Must NOT do**:
  - Do not add runtime integration dependencies to core.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - public API and module wiring.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after dependencies
  - **Parallel Group**: Wave 2
  - **Blocks**: 14, 15, 16
  - **Blocked By**: 2, 3, 11

  **References**:
  - `packages/nest-batch/src/module/nest-batch.module.ts` - dynamic module/provider wiring.
  - `packages/nest-batch/src/index.ts` - public exports.
  - `packages/nest-batch/src/core/repository/job-repository.ts` - repository token contract.
  - `packages/nest-batch/src/core/transaction/transaction-manager.ts` - transaction token contract.

  **Acceptance Criteria**:
  - [ ] Core exposes documented tokens/interfaces required by sibling packages.
  - [ ] Public API snapshot/import-smoke tests pass.
  - [ ] Dependency boundary tests pass.
  - [ ] Shared contract tests still pass.

  **QA Scenarios**:
  ```
  Scenario: Core tokens import from package root
    Tool: Bash
    Preconditions: Import smoke test exists.
    Steps:
      1. Run public API import-smoke test.
      2. Assert tokens/interfaces import from `@nest-batch/core` without deep paths.
    Expected Result: Public imports compile.
    Evidence: .omo/evidence/task-12-core-tokens.txt

  Scenario: Core remains integration-free
    Tool: Bash
    Preconditions: Boundary test exists.
    Steps:
      1. Run dependency boundary test.
      2. Assert no integration packages are imported by core.
    Expected Result: Boundary passes.
    Evidence: .omo/evidence/task-12-core-boundary.txt
  ```

  **Commit**: YES
  - Message: `feat(core): expose adapter tokens`
  - Files: `packages/nest-batch/src/**`, tests
  - Pre-commit: `pnpm --filter @nest-batch/core test && pnpm lint`

- [x] 13. Define Spring Batch-like cron decorator API contract

  **What to do**:
  - RED: add tests/API snapshots for decorator names and metadata: propose names such as `@BatchScheduled`, `@ScheduledBatchJob`, or final chosen Spring Batch-like equivalent.
  - Use `cron` package abstraction rules: required schedule name, timezone, overlap policy, lifecycle cleanup, inert test mode.
  - Keep implementation in core as metadata/contract only if runtime `cron` dependency belongs in `@nest-batch/bullmq` or scheduling package.

  **Must NOT do**:
  - Do not add admin UI or external scheduler alternatives.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - API design plus tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after boundary tests
  - **Parallel Group**: Wave 2
  - **Blocks**: 22
  - **Blocked By**: 2

  **References**:
  - `packages/nest-batch/src/decorators/**` - existing decorator conventions.
  - `packages/nest-batch/src/explorer/batch-explorer.ts` - metadata discovery.
  - `packages/nest-batch/src/module/nest-batch.module.ts` - lifecycle bootstrap.
  - Research: `cron`/Nest scheduling findings in draft.

  **Acceptance Criteria**:
  - [ ] Decorator API contract tests exist and fail before implementation.
  - [ ] Decorator metadata includes job id/name, cron expression, timezone, overlap policy.
  - [ ] Test mode/inert scheduling behavior is specified.
  - [ ] API snapshot is documented.

  **QA Scenarios**:
  ```
  Scenario: Cron decorator metadata is discoverable
    Tool: Bash
    Preconditions: Decorator API test exists.
    Steps:
      1. Run cron decorator metadata test.
      2. Assert discovered metadata includes name, expression, timezone, and overlap policy.
    Expected Result: Metadata is deterministic and testable.
    Evidence: .omo/evidence/task-13-cron-metadata.txt

  Scenario: Invalid cron decorator input fails clearly
    Tool: Bash
    Preconditions: Negative decorator test exists.
    Steps:
      1. Run invalid cron expression/timezone tests.
      2. Assert deterministic validation error.
    Expected Result: Invalid inputs do not silently register.
    Evidence: .omo/evidence/task-13-cron-negative.txt
  ```

  **Commit**: YES
  - Message: `test(core): define scheduled batch api`
  - Files: decorator tests/API docs
  - Pre-commit: `pnpm --filter @nest-batch/core test`

- [x] 14. Rename/extract current library into `@nest-batch/core` package layout

  **What to do**:
  - Move/rename workspace directory if desired so directory matches `@nest-batch/core` while preserving package name and exports.
  - Update workspace references, tsconfig paths, build scripts, and demo imports.
  - Preserve core package behavior and tests.

  **Must NOT do**:
  - Do not introduce sibling package implementation in this task.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - multi-file workspace/package refactor.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `git-master` - no commit operation unless executor commits.

  **Parallelization**:
  - **Can Run In Parallel**: YES after core tokens
  - **Parallel Group**: Wave 3
  - **Blocks**: 15, 16, 17, 19, 23
  - **Blocked By**: 12

  **References**:
  - `pnpm-workspace.yaml` - workspace patterns.
  - `packages/nest-batch/package.json` - current `@nest-batch/core` package name.
  - `tsconfig.base.json` - path/module conventions.
  - `apps/demo/package.json` - demo dependency on core.

  **Acceptance Criteria**:
  - [ ] `@nest-batch/core` package builds and tests pass after directory/package layout update.
  - [ ] Demo app imports still resolve.
  - [ ] Workspace commands work from root.

  **QA Scenarios**:
  ```
  Scenario: Core package builds after extraction
    Tool: Bash
    Preconditions: Package layout refactor complete.
    Steps:
      1. Run `pnpm --filter @nest-batch/core build`.
      2. Run `pnpm --filter @nest-batch/core test`.
    Expected Result: Both commands exit 0.
    Evidence: .omo/evidence/task-14-core-build.txt

  Scenario: Demo resolves core import
    Tool: Bash
    Preconditions: Demo package depends on workspace core.
    Steps:
      1. Run `pnpm --filter @nest-batch/demo typecheck`.
      2. Assert no module resolution errors for `@nest-batch/core`.
    Expected Result: Demo typecheck passes.
    Evidence: .omo/evidence/task-14-demo-core-import.txt
  ```

  **Commit**: YES
  - Message: `refactor(core): align package layout`
  - Files: workspace/package/config files
  - Pre-commit: `pnpm build && pnpm typecheck && pnpm test`

- [x] 15. Extract `@nest-batch/mikro-orm` package

  **What to do**:
  - TDD: make shared contract suite runnable against package-owned MikroORM schema/entities/migrations.
  - Move demo MikroORM repository/transaction manager into sibling package.
  - Package owns batch meta entities/schema/migration artifacts.
  - Demo imports adapter package rather than local adapter files.

  **Must NOT do**:
  - Do not include user-domain `ProductEntity` in adapter package.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - package extraction plus ORM integration.
  - **Skills**: [`db-migrate`]
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 16-19 after core extraction
  - **Parallel Group**: Wave 3
  - **Blocks**: 20, 21
  - **Blocked By**: 3, 10, 14

  **References**:
  - `apps/demo/src/adapters/mikroorm/mikroorm-job-repository.ts` - extraction source.
  - `apps/demo/src/adapters/mikroorm/mikroorm-transaction-manager.ts` - extraction source.
  - `apps/demo/src/entities/job-meta.entities.ts` - batch meta schema source.
  - `apps/demo/migrations/*` - migration source.

  **Acceptance Criteria**:
  - [ ] New `@nest-batch/mikro-orm` workspace package exists.
  - [ ] Package has hard peer dependencies for MikroORM/Nest/Core.
  - [ ] Package-owned schema/migrations are exported/documented.
  - [ ] Shared contract tests pass against MikroORM implementation.
  - [ ] Demo no longer uses local MikroORM adapter files.

  **QA Scenarios**:
  ```
  Scenario: MikroORM package passes contract
    Tool: Bash
    Preconditions: PostgreSQL test DB available.
    Steps:
      1. Run `pnpm --filter @nest-batch/mikro-orm test`.
      2. Assert shared repository/transaction contracts pass.
    Expected Result: Contract suite exits 0.
    Evidence: .omo/evidence/task-15-mikro-contract.txt

  Scenario: Demo imports package adapter
    Tool: Bash
    Preconditions: Demo migrated away from local adapter.
    Steps:
      1. Run `pnpm --filter @nest-batch/demo typecheck`.
      2. Assert no imports from `apps/demo/src/adapters/mikroorm` remain except deleted/compat files.
    Expected Result: Demo compiles using `@nest-batch/mikro-orm`.
    Evidence: .omo/evidence/task-15-demo-mikro-import.txt
  ```

  **Commit**: YES
  - Message: `feat(mikro-orm): extract batch repository package`
  - Files: `packages/*mikro*`, demo imports, tests
  - Pre-commit: `pnpm --filter @nest-batch/mikro-orm test && pnpm --filter @nest-batch/demo typecheck`

- [x] 16. Implement `@nest-batch/typeorm` package for TypeORM 1.0.0

  **What to do**:
  - TDD: run shared repository/transaction contract suite against TypeORM 1.0.0.
  - Implement TypeORM batch meta entities/schema/migrations owned by package.
  - Implement TypeORM `JobRepository` and `TransactionManager` with DB-first semantics.
  - Add package exports and README usage.

  **Must NOT do**:
  - Do not support TypeORM 0.3 in this plan.
  - Do not add TypeORM dependency to core.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - new adapter package.
  - **Skills**: [`db-migrate`]
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 15, 17, 19
  - **Parallel Group**: Wave 3
  - **Blocks**: 20, 23
  - **Blocked By**: 3, 14

  **References**:
  - `packages/nest-batch/src/core/repository/job-repository.ts` - implementation contract.
  - `apps/demo/src/entities/job-meta.entities.ts` - schema parity reference.
  - TypeORM 1.0.0 docs/release notes - target API.
  - `@nest-batch/mikro-orm` package from Task 15 - sibling package pattern.

  **Acceptance Criteria**:
  - [ ] `@nest-batch/typeorm` package exists and targets TypeORM 1.0.0 only.
  - [ ] Shared contract tests pass against TypeORM implementation.
  - [ ] Package exports entities/schema/migrations/reference artifacts.
  - [ ] Peer dependencies do not allow TypeORM 0.3.

  **QA Scenarios**:
  ```
  Scenario: TypeORM package passes contract
    Tool: Bash
    Preconditions: TypeORM 1.0.0 test DB setup available.
    Steps:
      1. Run `pnpm --filter @nest-batch/typeorm test`.
      2. Assert shared contract suite passes.
    Expected Result: 0 contract failures.
    Evidence: .omo/evidence/task-16-typeorm-contract.txt

  Scenario: TypeORM peer range rejects 0.3
    Tool: Bash
    Preconditions: `@nest-batch/typeorm/package.json` exists.
    Steps:
      1. Inspect package peerDependencies.
      2. Assert `typeorm` range is `^1.0.0` or equivalent and excludes `^0.3`.
    Expected Result: TypeORM 1.0.0-only policy encoded.
    Evidence: .omo/evidence/task-16-typeorm-peer.txt
  ```

  **Commit**: YES
  - Message: `feat(typeorm): add batch repository package`
  - Files: `packages/*typeorm*`, tests, docs
  - Pre-commit: `pnpm --filter @nest-batch/typeorm test`

- [x] 17. Implement `@nest-batch/bullmq` package skeleton and Redis local setup

  **What to do**:
  - TDD: add import/package boundary tests proving BullMQ dependency lives only in `@nest-batch/bullmq`.
  - Create workspace package with hard peer deps on BullMQ/Nest/Core.
  - Add Redis service to local docker compose with `noeviction`, append-only persistence, healthcheck, and namespace prefix docs.
  - Add module skeleton exposing BullMQ transport strategy provider.

  **Must NOT do**:
  - Do not implement full worker execution in this task.

  **Recommended Agent Profile**:
  - **Category**: `deep` - new package plus infra wiring.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `aws` - local Redis only.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 15, 16, 19 after core extraction
  - **Parallel Group**: Wave 3
  - **Blocks**: 18
  - **Blocked By**: 11, 14

  **References**:
  - BullMQ research in draft - connection/lifecycle guidance.
  - `docker-compose.yml` - existing PostgreSQL local dev setup.
  - `packages/nest-batch/src/module/nest-batch.module.ts` - module pattern.
  - `packages/nest-batch/src/execution/job-launcher.ts` - strategy integration target.

  **Acceptance Criteria**:
  - [ ] `@nest-batch/bullmq` workspace package exists.
  - [ ] BullMQ appears only in bullmq package dependencies/imports.
  - [ ] Redis local service is documented and healthchecked.
  - [ ] BullMQ module skeleton registers an execution strategy token.
  - [ ] Package builds and import smoke test passes.

  **QA Scenarios**:
  ```
  Scenario: BullMQ package builds without contaminating core
    Tool: Bash
    Preconditions: BullMQ package skeleton exists.
    Steps:
      1. Run `pnpm --filter @nest-batch/bullmq build`.
      2. Run core dependency boundary test.
    Expected Result: BullMQ package builds; core remains BullMQ-free.
    Evidence: .omo/evidence/task-17-bullmq-build-boundary.txt

  Scenario: Redis service healthcheck works
    Tool: Bash
    Preconditions: Docker available and compose updated.
    Steps:
      1. Run compose service startup command documented by executor.
      2. Run `redis-cli ping` via container or equivalent healthcheck.
    Expected Result: Redis responds `PONG` and uses configured service.
    Evidence: .omo/evidence/task-17-redis-health.txt
  ```

  **Commit**: YES
  - Message: `feat(bullmq): add package skeleton and redis dev`
  - Files: `packages/*bullmq*`, `docker-compose.yml`, docs/tests
  - Pre-commit: `pnpm --filter @nest-batch/bullmq build && pnpm test`

- [x] 18. Implement BullMQ step/partition runtime bridge and DB-first state bridge

  **What to do**:
  - GREEN BullMQ integration tests.
  - Implement BullMQ execution strategy using Queue/Worker/FlowProducer/QueueEvents.
  - Map `JobLauncher.launch()` to enqueue step-level or partition-level execution units while preserving canonical DB execution rows.
  - Ensure BullMQ processors invoke Batch Core for Job/Step/Reader/Processor/Writer semantics.
  - Keep chunking, checkpoint, restart, chunk transaction, skip, and business retry inside Batch Core.
  - Map technical/runtime retry, backoff, rate limit, scheduler, worker distribution, and partition parallelism to BullMQ.
  - Implement graceful shutdown, error listeners, producer fail-fast config, worker retry config, and event bridge.
  - Integrate scheduled/cron jobs through BullMQ scheduler where appropriate.

  **Must NOT do**:
  - Do not make Redis the canonical execution state store.
  - Do not add UI/metrics/tracing implementations.
  - Do not create one BullMQ job per row/item.
  - Do not move business skip/retry policy out of Batch Core.

  **Recommended Agent Profile**:
  - **Category**: `deep` - distributed worker lifecycle and state semantics.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `aws` - no cloud Redis/prod deployment.

  **Parallelization**:
  - **Can Run In Parallel**: NO, depends on skeleton and core correctness
  - **Parallel Group**: Wave 3 after Task 17
  - **Blocks**: 20, 21, 22
  - **Blocked By**: 17, 8, 9

  **References**:
  - `@nest-batch/bullmq` skeleton from Task 17.
  - `packages/nest-batch/src/execution/job-launcher.ts` - strategy delegation.
  - `packages/nest-batch/src/core/repository/job-repository.ts` - DB-first state contract.
  - BullMQ docs: Queue, Worker, FlowProducer, QueueEvents, graceful shutdown, Redis connection.

  **Acceptance Criteria**:
  - [ ] Queue enqueue creates/updates canonical DB execution state through repository contract.
  - [ ] Worker executes registered job using core execution pipeline.
  - [ ] BullMQ jobs represent steps or partitions only; tests prove no row-per-job behavior.
  - [ ] Batch Core remains responsible for checkpoint/restart/chunk transaction/skip/business retry.
  - [ ] BullMQ is responsible for technical retry/backoff/rate limit/worker distribution only.
  - [ ] QueueEvents bridge emits/records completion/failure events.
  - [ ] Graceful shutdown closes Worker/Queue/QueueEvents/FlowProducer.
  - [ ] Redis-down producer failure is deterministic and tested.

  **QA Scenarios**:
  ```
  Scenario: BullMQ transport executes DB-first job
    Tool: Bash
    Preconditions: Redis and DB services running.
    Steps:
      1. Run `pnpm --filter @nest-batch/bullmq test`.
      2. Assert test enqueues job, worker completes it, and repository execution status becomes COMPLETED.
    Expected Result: BullMQ job and DB execution state agree.
    Evidence: .omo/evidence/task-18-bullmq-db-first.txt

  Scenario: BullMQ creates partition jobs, not row jobs
    Tool: Bash
    Preconditions: BullMQ adapter integration test includes fixture with at least 25 input rows and partition size or step-unit configuration.
    Steps:
      1. Run BullMQ partition granularity test.
      2. Count BullMQ jobs created for the fixture.
      3. Assert job count equals expected step/partition count, not row count.
    Expected Result: BullMQ job count is much lower than row count and matches partition/step model.
    Evidence: .omo/evidence/task-18-bullmq-no-row-jobs.txt

  Scenario: Business skip remains in Batch Core
    Tool: Bash
    Preconditions: Fixture includes business-invalid rows and BullMQ attempts configured for technical failures.
    Steps:
      1. Run skip/retry split integration test.
      2. Assert invalid business rows are skipped by Batch Core policy without consuming BullMQ technical attempts.
      3. Assert Redis/technical failure uses BullMQ retry/backoff.
    Expected Result: Business and technical retry paths are observably separate.
    Evidence: .omo/evidence/task-18-retry-split.txt

  Scenario: Redis producer fails fast when unavailable
    Tool: Bash
    Preconditions: Redis service stopped for negative test.
    Steps:
      1. Run Redis-down producer test.
      2. Assert failure occurs within configured timeout and does not create DB-completed state.
    Expected Result: Deterministic failure, no hanging test.
    Evidence: .omo/evidence/task-18-bullmq-redis-down.txt
  ```

  **Commit**: YES
  - Message: `feat(bullmq): add db-first execution strategy`
  - Files: `packages/*bullmq*/**`, tests
  - Pre-commit: `pnpm --filter @nest-batch/bullmq test`

- [x] 19. Write package READMEs and migration notes

  **What to do**:
  - Add package-level README files for core, MikroORM, TypeORM, BullMQ.
  - Document lockstep versioning, breaking migration story, dependency boundaries, and quickstart composition.
  - Document Drizzle exclusion/deferred status.
  - Add examples for in-process strategy and BullMQ strategy.

  **Must NOT do**:
  - Do not promise unsupported Drizzle/admin/metrics/tracing features.

  **Recommended Agent Profile**:
  - **Category**: `writing` - documentation task.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after package skeletons exist
  - **Parallel Group**: Wave 3
  - **Blocks**: 24
  - **Blocked By**: 14, 15, 16, 17, 18

  **References**:
  - Root `README.md` - current workspace/tooling docs.
  - Package `package.json` files - package names/peer dependencies.
  - Research draft - decisions and guardrails.
  - `apps/demo` - real usage example.

  **Acceptance Criteria**:
  - [ ] Each package has README or docs section.
  - [ ] Migration notes state breaking new major-structure release.
  - [ ] Drizzle is explicitly out of scope/deferred.
  - [ ] Docs include local Redis command and DB-first BullMQ semantics.

  **QA Scenarios**:
  ```
  Scenario: Package docs mention required peer dependencies
    Tool: Bash
    Preconditions: README files exist.
    Steps:
      1. Search package READMEs for peer dependency names.
      2. Assert each adapter README names its required peers.
    Expected Result: No adapter has undocumented peer dependencies.
    Evidence: .omo/evidence/task-19-peer-docs.txt

  Scenario: Scope exclusions are documented
    Tool: Bash
    Preconditions: Migration docs exist.
    Steps:
      1. Search docs for `Drizzle`, `admin`, `metrics`, and `tracing` scope notes.
      2. Assert docs do not promise implementation for excluded features.
    Expected Result: Exclusions are clear and no false promises exist.
    Evidence: .omo/evidence/task-19-scope-docs.txt
  ```

  **Commit**: YES
  - Message: `docs: document nest-batch package family`
  - Files: `README.md`, package READMEs/docs
  - Pre-commit: `pnpm format:check`

- [x] 20. Migrate demo app to package imports and strategy-backed launcher

  **What to do**:
  - Update demo to import MikroORM/TypeORM/BullMQ packages instead of local adapter implementations.
  - Configure `JobLauncher` strategy selection for in-process and BullMQ modes.
  - Preserve existing `POST /jobs/import-products` controller shape.
  - Remove or mark old local adapter files obsolete after tests prove package imports.

  **Must NOT do**:
  - Do not add new demo features beyond package migration.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - demo integration migration.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES in Wave 4 after package implementations
  - **Parallel Group**: Wave 4
  - **Blocks**: 21, 22, 24
  - **Blocked By**: 15, 16, 18, 11

  **References**:
  - `apps/demo/src/app.module.ts` - provider wiring.
  - `apps/demo/src/controller/batch.controller.ts` - API surface to preserve.
  - `apps/demo/src/jobs/import-products/**` - job fixture.
  - New adapter package READMEs from Task 19.

  **Acceptance Criteria**:
  - [ ] Demo typechecks using package imports.
  - [ ] Existing controller tests pass unchanged or with only provider setup changes.
  - [ ] In-process strategy remains available for simple/local mode.
  - [ ] BullMQ strategy is selectable/configurable.

  **QA Scenarios**:
  ```
  Scenario: Demo controller API unchanged
    Tool: Bash
    Preconditions: Demo migrated.
    Steps:
      1. Run `pnpm --filter @nest-batch/demo test -- batch.controller`.
      2. Assert `POST /jobs/import-products` tests still pass.
    Expected Result: Controller contract preserved.
    Evidence: .omo/evidence/task-20-demo-controller.txt

  Scenario: Demo imports sibling packages
    Tool: Bash
    Preconditions: Demo migrated.
    Steps:
      1. Run `pnpm --filter @nest-batch/demo typecheck`.
      2. Search for imports from old local adapter directory.
    Expected Result: Typecheck passes and old local adapter imports are gone.
    Evidence: .omo/evidence/task-20-demo-imports.txt
  ```

  **Commit**: YES
  - Message: `refactor(demo): use nest-batch packages`
  - Files: `apps/demo/**`, package references
  - Pre-commit: `pnpm --filter @nest-batch/demo test && pnpm --filter @nest-batch/demo typecheck`

- [x] 21. Add Redis + DB e2e for BullMQ execution path

  **What to do**:
  - TDD/e2e: start Redis + DB, enqueue demo job through `JobLauncher`, execute via BullMQ worker, assert DB state and output.
  - Verify BullMQ jobs are step/partition units while item/chunk processing remains inside Batch Core.
  - Cover completion, failure, retry, restart/checkpoint, Redis-down negative, and worker graceful shutdown.
  - Save deterministic logs/evidence.

  **Must NOT do**:
  - Do not require manual browser/UI testing.

  **Recommended Agent Profile**:
  - **Category**: `deep` - multi-service integration.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `playwright` - no browser UI.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 22-24 after demo migration
  - **Parallel Group**: Wave 4
  - **Blocks**: 24
  - **Blocked By**: 18, 20, 10

  **References**:
  - `apps/demo/tests/e2e/import-products.e2e.spec.ts` - existing DB e2e baseline.
  - `docker-compose.yml` - service startup.
  - `packages/*bullmq*/tests/**` - BullMQ integration tests.
  - `apps/demo/sample-data/**` - fixture inputs.

  **Acceptance Criteria**:
  - [ ] E2E passes with Redis + DB services.
  - [ ] DB job/step execution rows reflect BullMQ-run completion/failure while item/chunk semantics remain Batch Core-owned.
  - [ ] E2E proves BullMQ job granularity is step/partition, not row/item.
  - [ ] Retry/backoff behavior is tested with short deterministic delays.
  - [ ] Worker shutdown test closes without stalled/leaked job.

  **QA Scenarios**:
  ```
  Scenario: Demo BullMQ import-products completes
    Tool: Bash (curl + pnpm/e2e)
    Preconditions: Redis and DB services running; demo e2e configured for BullMQ strategy.
    Steps:
      1. Run BullMQ demo e2e command documented by executor.
      2. Trigger import-products job with fixture CSV.
      3. Assert DB execution status is COMPLETED and products inserted.
    Expected Result: Job completes through BullMQ transport and DB state is canonical.
    Evidence: .omo/evidence/task-21-demo-bullmq-complete.txt

  Scenario: Demo import uses step/partition BullMQ granularity
    Tool: Bash
    Preconditions: Demo fixture contains multiple rows and BullMQ strategy enabled.
    Steps:
      1. Run demo BullMQ import e2e.
      2. Query BullMQ/QueueEvents or test harness for created job count.
      3. Compare count against input row count.
    Expected Result: BullMQ jobs correspond to step/partition units, not one job per product row.
    Evidence: .omo/evidence/task-21-demo-no-row-jobs.txt

  Scenario: Worker shutdown does not orphan active job
    Tool: Bash
    Preconditions: E2E includes long-running job fixture.
    Steps:
      1. Start worker and enqueue long-running job.
      2. Send shutdown signal or close worker through test harness.
      3. Assert job is completed or recoverable per contract, not permanently orphaned.
    Expected Result: Graceful shutdown behavior matches contract.
    Evidence: .omo/evidence/task-21-worker-shutdown.txt
  ```

  **Commit**: YES
  - Message: `test(demo): verify bullmq execution path`
  - Files: demo e2e tests/config
  - Pre-commit: `pnpm --filter @nest-batch/demo test:e2e`

- [x] 22. Add cron decorator e2e for timezone and overlap behavior

  **What to do**:
  - GREEN for Task 13 cron contract tests and e2e runtime behavior.
  - Verify scheduled job registration, timezone validation, invalid cron rejection, overlap/misfire policy, and inert test mode.
  - Ensure cron scheduling can target BullMQ strategy without making core depend on BullMQ.

  **Must NOT do**:
  - Do not add UI or schedule management endpoints.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` - time/lifecycle behavior tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `playwright` - no browser UI.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Task 21
  - **Parallel Group**: Wave 4
  - **Blocks**: 24
  - **Blocked By**: 13, 18, 20

  **References**:
  - Cron decorator tests from Task 13.
  - `packages/nest-batch/src/decorators/**` - metadata conventions.
  - `packages/*bullmq*/**` - scheduled transport integration.
  - Research findings: timezone, overlap, lifecycle cleanup.

  **Acceptance Criteria**:
  - [ ] Scheduled decorator registers a named schedule.
  - [ ] Invalid cron expression/timezone fails deterministically.
  - [ ] Overlap policy is tested: skip/queue/parallel behavior as documented.
  - [ ] Inert test mode prevents timers from leaking.

  **QA Scenarios**:
  ```
  Scenario: Scheduled job enqueues through BullMQ
    Tool: Bash
    Preconditions: Redis service running; scheduled test module configured.
    Steps:
      1. Run cron e2e with fake timers or short interval.
      2. Assert one BullMQ job is enqueued and DB execution row exists.
    Expected Result: Schedule produces exactly one expected job.
    Evidence: .omo/evidence/task-22-cron-enqueue.txt

  Scenario: Overlap policy prevents duplicate execution
    Tool: Bash
    Preconditions: Scheduled job duration exceeds interval.
    Steps:
      1. Run overlap e2e.
      2. Assert configured overlap behavior: skipped or queued, not accidental parallel execution.
    Expected Result: Overlap behavior matches documentation.
    Evidence: .omo/evidence/task-22-cron-overlap.txt
  ```

  **Commit**: YES
  - Message: `feat(schedule): add batch cron decorators`
  - Files: decorators/scheduler/bullmq tests
  - Pre-commit: `pnpm test`

- [x] 23. Validate package dry-run and peer dependency boundaries

  **What to do**:
  - Run `pnpm pack --dry-run` or equivalent for each package.
  - Validate package files, `exports`, `types`, peerDependencies, dependency boundaries, and lockstep versioning.
  - Confirm TypeORM peer is 1.0.0-only and Drizzle package is absent.

  **Must NOT do**:
  - Do not publish packages.

  **Recommended Agent Profile**:
  - **Category**: `quick` - packaging validation.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `pr-ready` - no PR creation requested.

  **Parallelization**:
  - **Can Run In Parallel**: YES with Tasks 21, 22, 24
  - **Parallel Group**: Wave 4
  - **Blocks**: 24
  - **Blocked By**: 1, 2, 14, 15, 16, 17, 18, 19

  **References**:
  - Package `package.json` files.
  - `pnpm-workspace.yaml`.
  - READMEs from Task 19.
  - Boundary tests from Task 2.

  **Acceptance Criteria**:
  - [ ] Dry-run succeeds for core, mikro-orm, typeorm, bullmq packages.
  - [ ] Package tarballs include dist/types/docs and exclude tests/internal artifacts as appropriate.
  - [ ] Peer dependencies match decisions.
  - [ ] No `@nest-batch/drizzle` package exists.

  **QA Scenarios**:
  ```
  Scenario: All packages pack dry-run
    Tool: Bash
    Preconditions: Packages build successfully.
    Steps:
      1. Run pack dry-run command for each `@nest-batch/*` package in scope.
      2. Capture file list and peer dependency output.
    Expected Result: Dry-run exits 0 for all scoped packages.
    Evidence: .omo/evidence/task-23-pack-dry-run.txt

  Scenario: Drizzle package absent
    Tool: Bash
    Preconditions: Workspace packages exist.
    Steps:
      1. Search workspace package names for `drizzle`.
      2. Assert no `@nest-batch/drizzle` package is declared.
    Expected Result: Drizzle excluded from this plan.
    Evidence: .omo/evidence/task-23-no-drizzle.txt
  ```

  **Commit**: YES
  - Message: `chore: validate package boundaries`
  - Files: package manifests/exports if needed
  - Pre-commit: `pnpm build && pnpm test`

- [x] 24. Final docs and examples sweep

  **What to do**:
  - Ensure root README explains package family, local Redis/DB setup, demo commands, and migration story.
  - Ensure examples align with actual package imports and strategy selection.
  - Ensure docs do not mention unsupported Drizzle implementation except as out-of-scope/deferred.
  - Capture final verification commands and expected outputs.

  **Must NOT do**:
  - Do not add unrelated tutorial content or speculative roadmap promises.

  **Recommended Agent Profile**:
  - **Category**: `writing` - final documentation consistency.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: none.

  **Parallelization**:
  - **Can Run In Parallel**: YES after integration work
  - **Parallel Group**: Wave 4
  - **Blocks**: F1-F4
  - **Blocked By**: 19, 20, 21, 22, 23

  **References**:
  - Root `README.md`.
  - Package READMEs.
  - Demo app files.
  - Evidence from Tasks 21-23.

  **Acceptance Criteria**:
  - [ ] Root docs and package docs are consistent.
  - [ ] Example commands are executable and verified.
  - [ ] Migration/breaking-change notes are explicit.
  - [ ] Final command checklist exists.

  **QA Scenarios**:
  ```
  Scenario: Documented quickstart commands work
    Tool: Bash
    Preconditions: Docs list quickstart commands.
    Steps:
      1. Run each documented non-destructive quickstart command.
      2. Capture output and assert commands exit 0.
    Expected Result: Docs are executable, not aspirational.
    Evidence: .omo/evidence/task-24-doc-commands.txt

  Scenario: Documentation matches package scope
    Tool: Bash
    Preconditions: Docs complete.
    Steps:
      1. Search docs for `@nest-batch/core`, `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/bullmq`.
      2. Search docs for `@nest-batch/drizzle` and assert it is only described as excluded/deferred.
    Expected Result: In-scope packages documented; Drizzle not promised.
    Evidence: .omo/evidence/task-24-doc-scope.txt
  ```

  **Commit**: YES
  - Message: `docs: finalize package examples`
  - Files: docs/READMEs/examples only
  - Pre-commit: `pnpm format:check && pnpm test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each Must Have: verify implementation exists (read file, run command). For each Must NOT Have: search codebase for forbidden patterns, including `@nest-batch/drizzle`, core imports of BullMQ/ORM/cron implementation packages, and lazy optional `require()` patterns. Check evidence files exist in `.omo/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Review changed files for `as any`, `@ts-ignore`, empty catches, unclosed Redis/DB resources, console logs, commented-out code, circular package imports, and public API drift.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state with Redis + DB. Execute EVERY QA scenario from EVERY task, including BullMQ demo e2e, package dry-run, CI-equivalent local commands, and cron schedule tests. Save evidence to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  Compare actual diff to this plan. Verify no Drizzle package, no admin UI, no metrics/tracing implementations, no alternative queue transports, no hidden optional lazy dependencies, and no core integration imports. Flag unaccounted files and scope creep.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **1**: `ci: add package quality workflow` - CI workflow only.
- **2-3**: `test(core): guard adapter contracts` - boundary/API/contract test scaffolding.
- **4-9**: `fix(core): stabilize listener and ref resolution` - listener/ref correctness.
- **10**: `fix(mikro-orm): restore checkpoint lookup` - MikroORM restart correctness.
- **11-13**: `feat(core): add strategy and schedule contracts` - strategy/cron/tokens.
- **14**: `refactor(core): align package layout` - package layout.
- **15**: `feat(mikro-orm): extract repository package` - MikroORM package.
- **16**: `feat(typeorm): add repository package` - TypeORM package.
- **17-18**: `feat(bullmq): add db-first transport strategy` - BullMQ package.
- **19,24**: `docs: document nest-batch package family` - docs.
- **20-22**: `test(demo): verify package integrations` - demo/e2e.
- **23**: `chore: validate package boundaries` - package manifests/exports.

---

## Success Criteria

### Verification Commands
```bash
pnpm install --frozen-lockfile  # Expected: installs without peer conflicts
pnpm build                      # Expected: all packages build
pnpm lint                       # Expected: no lint/boundary violations
pnpm typecheck                  # Expected: strict TypeScript passes
pnpm test                       # Expected: unit + contract + e2e tests pass
pnpm --filter @nest-batch/core test        # Expected: core TDD suite passes
pnpm --filter @nest-batch/mikro-orm test   # Expected: MikroORM contract passes
pnpm --filter @nest-batch/typeorm test     # Expected: TypeORM 1.0.0 contract passes
pnpm --filter @nest-batch/bullmq test      # Expected: Redis/BullMQ integration passes
pnpm --filter @nest-batch/demo test:e2e    # Expected: demo Redis+DB e2e passes
```

### Final Checklist
- [ ] All Must Have items present.
- [ ] All Must NOT Have items absent.
- [ ] Drizzle excluded from workspace packages.
- [ ] Core has no BullMQ/ORM/cron implementation imports.
- [ ] `JobLauncher` is strategy-backed and public API is preserved.
- [ ] BullMQ execution path writes canonical state through DB/ORM repositories.
- [ ] BullMQ only distributes step/partition execution units; no row-per-job implementation exists.
- [ ] Batch Core owns Job/Step/Reader/Processor/Writer, checkpoint/restart, chunk transaction, skip, and business retry semantics.
- [ ] BullMQ owns only technical/runtime retry, backoff, rate limiting, worker distribution, partition parallelism, and optional scheduling.
- [ ] MikroORM and TypeORM adapter packages own batch metadata schema/migrations/reference artifacts.
- [ ] CI workflow exists and mirrors local quality gates.
- [ ] Evidence exists for every task and final verification wave.
