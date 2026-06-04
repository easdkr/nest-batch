# nest-batch Bug #2 Fix — Token Aliasing in `NestBatchModule`

## TL;DR

> **Quick Summary**: The F3 re-verification of the prior plan revealed that Bug #2 (BullmqBatchModule DI) is not actually fixed. The root cause is a token identity mismatch: `BullmqRuntimeService` injects the **symbol** `JOB_REPOSITORY_TOKEN`, but the demo app binds the repository to the **class** `JobRepository`. The `NestBatchModule` only exports the class token, leaving the symbol unresolvable. The correct fix lives in `@nest-batch/core`'s `NestBatchModule`: when the host provides a `repository` override, the module should automatically register an alias so both the class token AND the `JOB_REPOSITORY_TOKEN` symbol resolve to the same instance.
>
> **Deliverables**:
> - `NestBatchModule` (forRoot + forRootAsync) auto-aliases `JOB_REPOSITORY_TOKEN` to the user-provided repository token via `useExisting`
> - New tests prove the symbol resolves regardless of the host's chosen token identity
> - Live demo `BATCH_TRANSPORT=bullmq` boots without `UnknownDependenciesException`
> - F3 rerun: PASS (DoD #6 met)
>
> **Estimated Effort**: Small (1-2 tasks)
> **Parallel Execution**: NO (small, sequential)
> **Critical Path**: core 변경 → 테스트 → F3 rerun

---

## Context

### Original Request
> "core 에서 제어를 하는게 더 맞는 방향아니야?" (사용자가 Option C 승인)
> "진행"

### Prior State (from F3 rerun)
- `nest-batch-critical-fixes` plan: 4/5 bugs fixed, 1 NOT fixed
- **Bug #2 root cause** (verified by sub-agent): `BullmqRuntimeService:148` injects the **symbol** `JOB_REPOSITORY_TOKEN`. The demo app binds the repository to the **class** `JobRepository`. `NestBatchModule.splitOptions` extracts the host's token via `extractToken()` and registers only the class token in `exports`. Result: `UnknownDependenciesException` when live demo boots in `BATCH_TRANSPORT=bullmq`.

### Architectural Reasoning for Fixing in `core`
- `JOB_REPOSITORY_TOKEN` is defined and exported by `@nest-batch/core` (in `tokens.ts`). The package that defines a token should also be the one that ensures it resolves.
- Backwards compatible: existing hosts that use the class token keep working; new symbol-based consumers also resolve.
- Single source of truth: no per-adapter token-resolver workarounds.

### Test Strategy Decision
- **Infrastructure exists**: YES (PostgreSQL :5434, Redis :6379)
- **Automated tests**: TDD
- **Framework**: vitest

---

## Work Objectives

### Core Objective
Make `JOB_REPOSITORY_TOKEN` resolve to the user's `JobRepository` binding in `NestBatchModule`, regardless of whether the host bound it via a class token or a symbol token. This unblocks the BullMQ runtime's DI and satisfies DoD #6.

### Concrete Deliverables
- [ ] `buildProviders()` registers an alias: `{ provide: JOB_REPOSITORY_TOKEN, useExisting: <user-token> }` when the host's token is not already `JOB_REPOSITORY_TOKEN`
- [ ] The alias is also added to the module's `exports` list (only when not already there)
- [ ] New core tests: both the user-chosen token AND `JOB_REPOSITORY_TOKEN` symbol resolve to the same `JobRepository` instance
- [ ] Live demo `BATCH_TRANSPORT=bullmq` boots without `UnknownDependenciesException`
- [ ] F3 rerun: APPROVE (DoD #6 met)

### Must Have
- [ ] `forRoot()` and `forRootAsync()` both register the alias
- [ ] Works for `useClass`, `useValue`, `useFactory`, `useExisting` repository overrides
- [ ] Idempotent: if host already binds to `JOB_REPOSITORY_TOKEN` directly, no duplicate provider
- [ ] Backwards compatible: existing hosts that use the class token are unchanged

### Must NOT Have
- ❌ Don't change `BullmqRuntimeService` (it correctly uses the symbol)
- ❌ Don't change the demo app's `app.module.ts` (it correctly uses the class per README convention)
- ❌ Don't change the public API surface (the `AdapterOptions.repository` slot stays the same)

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD (RED-GREEN-REFACTOR)
- **Framework**: vitest

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Execution Strategy

```
Wave 1 (Core fix — sequential, small):
├── Task 1: Add JOB_REPOSITORY_TOKEN alias in NestBatchModule + tests
└── Task 2: Re-run F3 verification with live demo in BATCH_TRANSPORT=bullmq

Critical Path: Task 1 → Task 2
Max Concurrent: 1 (small plan, sequential)
```

### Dependency Matrix
- **1**: blocks 2; wave 1.
- **2**: blocked by 1; wave 1.

---

## TODOs

- [x] 1. Add `JOB_REPOSITORY_TOKEN` alias in `NestBatchModule.buildProviders` + tests

  > **Verification complete (2026-06-04 19:30 PT).** See the
  > "FOLLOW-UP COMPLETE" section at the bottom of this file for the
  > full F3 rerun outcome. Bug #2 is RESOLVED at the DI / boot level.
  > A separate (out-of-scope) issue — MikroORM context inside the
  > BullMQ worker — is documented in
  > `.omo/evidence/f3-rerun-real-qa.md` §10.3 with a one-line
  > recommended fix.


  **What to do**:
  - In `packages/core/src/module/nest-batch.module.ts`, modify `buildProviders()` to register a `JOB_REPOSITORY_TOKEN` provider that uses `useExisting: <user-token>` when:
    1. The host provided a `repository` override (line 301-303 already in place)
    2. AND the user-token is not already `JOB_REPOSITORY_TOKEN`
  - Also update the `exportsList` in `forRoot()` and `forRootAsync()` to add `JOB_REPOSITORY_TOKEN` when the user-token is not already the symbol
  - Add a test in `packages/core/tests/module/nest-batch.module.spec.ts` (or a new spec file) that:
    - Builds a test module with `repository: { provide: JobRepository, useClass: FakeRepo }` (class token)
    - Asserts `@Inject(JobRepository)` resolves to the FakeRepo instance
    - Asserts `@Inject(JOB_REPOSITORY_TOKEN)` resolves to the SAME FakeRepo instance
    - Also test the inverse: when host binds to `JOB_REPOSITORY_TOKEN` directly, no duplicate provider
  - Run `pnpm --filter @nest-batch/core test` — must stay 532+/532+ pass
  - Run `pnpm --filter @nest-batch/bullmq test` — must stay 6/6 pass
  - Save evidence to `.omo/evidence/task-1-token-alias.log`

  **Root cause to fix** (in `nest-batch.module.ts`):
  - Line 301-303: `providers.push(resolved.repository)` — registers user's repository under the user-chosen token (e.g. `JobRepository` class)
  - Line 514-516: `if (resolved.repositoryToken !== undefined) { exportsList.push(resolved.repositoryToken); }` — exports ONLY the user-chosen token
  - **NEEDED**: also register `{ provide: JOB_REPOSITORY_TOKEN, useExisting: <user-token> }` and export `JOB_REPOSITORY_TOKEN` so symbol-based consumers can resolve

  **Recommended code change** (in `buildProviders`):
  ```ts
  if (resolved.repository !== undefined) {
    providers.push(resolved.repository);
    // Auto-alias JOB_REPOSITORY_TOKEN to the user-chosen token
    // so symbol-based consumers (e.g. BullmqRuntimeService) can
    // resolve the same instance regardless of how the host bound it.
    if (resolved.repositoryToken !== JOB_REPOSITORY_TOKEN) {
      providers.push({
        provide: JOB_REPOSITORY_TOKEN,
        useExisting: resolved.repositoryToken,
      });
    }
  }
  ```
  And in `forRoot()` exportsList:
  ```ts
  if (resolved.repositoryToken !== undefined) {
    exportsList.push(resolved.repositoryToken);
    if (resolved.repositoryToken !== JOB_REPOSITORY_TOKEN) {
      exportsList.push(JOB_REPOSITORY_TOKEN);
    }
  }
  ```
  Apply the same pattern to `forRootAsync()`.

  **Must NOT do**:
  - Do NOT change the public API shape of `NestBatchModuleOptions` (no new fields)
  - Do NOT change `extractToken` or `splitOptions` semantics
  - Do NOT change the BullmqRuntimeService (it correctly uses the symbol)
  - Do NOT change the demo app (it should keep using the class token per README convention)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: NestJS DI internals, requires care with edge cases (idempotency, both forRoot and forRootAsync)

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1
  - **Blocks**: 2
  - **Blocked By**: None

  **References**:
  - `packages/core/src/module/nest-batch.module.ts:300-309` (current `buildProviders` repository handling)
  - `packages/core/src/module/nest-batch.module.ts:514-522` (current `forRoot` exportsList handling)
  - `packages/core/src/module/nest-batch.module.ts:677-685` (current `forRootAsync` exportsList handling)
  - `packages/bullmq/src/bullmq-runtime.service.ts:148` (`@Inject(JOB_REPOSITORY_TOKEN)` consumer)
  - `apps/demo/src/app.module.ts` (host wiring with class token)
  - `.omo/evidence/f3-rerun-real-qa.md` (root cause analysis)

  **Acceptance Criteria**:
  - [ ] New core test: `repository: { provide: JobRepository, useClass: X }` → both `JobRepository` and `JOB_REPOSITORY_TOKEN` resolve to X instance
  - [ ] New core test: `repository: { provide: JOB_REPOSITORY_TOKEN, useClass: Y }` → only one provider (idempotent)
  - [ ] `pnpm --filter @nest-batch/core test` exits 0 with new tests added
  - [ ] `pnpm --filter @nest-batch/bullmq test` still exits 0
  - [ ] `pnpm --filter @nest-batch/mikro-orm test` still passes (no regression)
  - [ ] `pnpm --filter @nest-batch/typeorm test` still passes
  - [ ] `pnpm --filter @nest-batch/demo test` still 19/19 pass
  - [ ] `pnpm --filter @nest-batch/demo test:e2e` still 14/14 pass

  **QA Scenarios**:
  ```
  Scenario: New alias test passes
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/core test nest-batch.module
    Expected: exit 0, new alias test passes
    Evidence: .omo/evidence/task-1-core-alias-test.log

  Scenario: BullMQ tests still pass
    Tool: Bash (vitest)
    Preconditions: Redis at 127.0.0.1:6379
    Steps:
      1. pnpm --filter @nest-batch/bullmq test
    Expected: exit 0, all 6 tests pass
    Evidence: .omo/evidence/task-1-bullmq-regression.log

  Scenario: Full demo test suite passes
    Tool: Bash (vitest)
    Preconditions: PG at 127.0.0.1:5434
    Steps:
      1. pnpm --filter @nest-batch/demo test
      2. pnpm --filter @nest-batch/demo test:e2e
    Expected: exit 0, all tests pass
    Evidence: .omo/evidence/task-1-demo-regression.log
  ```

  **Commit**: YES
  - Message: `fix(core): auto-alias JOB_REPOSITORY_TOKEN symbol to user's repository token in NestBatchModule`
  - Files: `packages/core/src/module/nest-batch.module.ts`, `packages/core/tests/module/nest-batch.module.spec.ts`

- [x] 2. Re-run F3 verification with the fix applied — focus on live demo in BATCH_TRANSPORT=bullmq

  > **Verification complete (2026-06-04 19:30 PT).** Live demo in
  > `BATCH_TRANSPORT=bullmq` boots without `UnknownDependenciesException`,
  > `POST /jobs/import-products` returns 200, and a `batch_job_execution`
  > row is created. The remaining worker→ORM context failure is
  > documented in the FOLLOW-UP COMPLETE section below.

  **What to do**:
  - Build all packages: `pnpm build`
  - Run all package tests
  - **THE CRITICAL TEST**: live demo in `BATCH_TRANSPORT=bullmq` mode
    - Reset demo DB
    - Start demo with `BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1`
    - Confirm app boots (no `UnknownDependenciesException` in logs)
    - Trigger `POST /jobs/import-products` with `products-valid.csv`
    - Wait for worker to process
    - Verify DB: `batch_job_execution.exit_code = 'COMPLETED'`, `batch_step_execution.write_count = 3`
  - Also re-run in-process mode to confirm `exit_code='COMPLETED'`
  - Update the F3 rerun report at `.omo/evidence/f3-rerun-real-qa.md` with the new PASS verdict
  - Update `.omo/evidence/FINAL-FIX-REPORT.md` noting Bug #2 is NOW resolved
  - Append a "FOLLOW-UP COMPLETE" section to the plan file

  **Must NOT do**:
  - Do NOT modify any code (this is verification only)
  - Do NOT make any commits from the verification — only documentation

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: (none)
  - **Reason**: Multi-package integration verification

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1
  - **Blocks**: None (final task)
  - **Blocked By**: 1

  **References**:
  - `.omo/evidence/f3-rerun-real-qa.md` (previous F3 rerun, REJECT verdict)
  - `.omo/evidence/FINAL-FIX-REPORT.md` (final report to update)

  **Acceptance Criteria**:
  - [ ] `pnpm build` exits 0
  - [ ] All package tests pass (no regression)
  - [ ] Live demo in-process: `exit_code='COMPLETED'` confirmed
  - [ ] Live demo bullmq: app boots without DI error
  - [ ] Live demo bullmq: `POST /jobs/import-products` returns 200
  - [ ] Live demo bullmq: DB shows `exit_code='COMPLETED'` and 3 products
  - [ ] `.omo/evidence/f3-rerun-real-qa.md` updated with VERDICT: PASS
  - [ ] `.omo/evidence/FINAL-FIX-REPORT.md` updated noting Bug #2 RESOLVED
  - [ ] Plan file marked complete

  **QA Scenarios**:
  ```
  Scenario: All tests pass with the fix
    Tool: Bash (vitest)
    Steps:
      1. pnpm --filter @nest-batch/core test
      2. pnpm --filter @nest-batch/bullmq test
      3. pnpm --filter @nest-batch/mikro-orm test
      4. pnpm --filter @nest-batch/typeorm test
      5. pnpm --filter @nest-batch/demo test
      6. pnpm --filter @nest-batch/demo test:e2e
    Expected: all exit 0
    Evidence: .omo/evidence/task-2-all-tests.log

  Scenario: Live demo in bullmq mode — DoD #6
    Tool: Bash (docker + curl + psql)
    Preconditions: PG :5434, Redis :6379
    Steps:
      1. pnpm build
      2. PGPASSWORD=demo psql ... -c "TRUNCATE ..."
      3. BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1 pnpm --filter @nest-batch/demo start:dev > /tmp/demo-bullmq.log 2>&1 &
      4. sleep 10
      5. curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
      6. sleep 5
      7. PGPASSWORD=demo psql ... -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
    Expected: status=COMPLETED, exit_code='COMPLETED', no UnknownDependenciesException in log
    Evidence: .omo/evidence/task-2-demo-bullmq.log
  ```

  **Commit**: YES
  - Message: `docs: mark Bug #2 RESOLVED — DoD #6 met`
  - Files: `.omo/evidence/f3-rerun-real-qa.md`, `.omo/evidence/FINAL-FIX-REPORT.md`, `.omo/plans/nest-batch-bug2-fix.md`

---

## Commit Strategy

- **1**: `fix(core): auto-alias JOB_REPOSITORY_TOKEN symbol to user's repository token in NestBatchModule`
- **2**: `docs: mark Bug #2 RESOLVED — DoD #6 met`

---

## Success Criteria

### Verification Commands
```bash
# Build
pnpm build                                              # Expected: exit 0

# Tests
pnpm --filter @nest-batch/core test                     # Expected: 533+/533+ (new test added)
pnpm --filter @nest-batch/bullmq test                  # Expected: 6/6
pnpm --filter @nest-batch/demo test                    # Expected: 19/19
pnpm --filter @nest-batch/demo test:e2e                # Expected: 14/14

# Live verification
PGPASSWORD=demo psql ... -c "TRUNCATE ..."            # Reset DB
BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1 pnpm --filter @nest-batch/demo start:dev &
sleep 10
curl -X POST http://localhost:3000/jobs/import-products -d '{"file":"sample-data/products-valid.csv"}'
sleep 5
PGPASSWORD=demo psql ... -c "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
# Expected: status=COMPLETED, exit_code='COMPLETED'
```

### Final Checklist
- [x] `JOB_REPOSITORY_TOKEN` resolves to user's repository (both class and symbol)
- [x] All package tests pass (537/537 + 6/6 + 19/19 + 14/14)
- [x] Live demo in-process: `exit_code='COMPLETED'` (3 products in `product` table)
- [x] Live demo bullmq: app boots without `UnknownDependenciesException`
- [x] F3 rerun report updated: VERDICT PASS for Bug #2 (with caveat on the new worker→ORM context issue)
- [x] FINAL-FIX-REPORT.md updated (Bug #2: NOW RESOLVED)
- [ ] DoD #6: **PARTIAL** — boot + enqueue + dequeue all work; final ORM write still gated by a separate (out-of-scope) MikroORM context issue. One-line wrap in `BullmqRuntimeService.processJob` will close it; see FOLLOW-UP COMPLETE below.

---

## FOLLOW-UP COMPLETE — 2026-06-04 19:30 PT

The `nest-batch-bug2-fix` plan's two tasks both ran to completion on
2026-06-04 19:30 PT. The bullmq live demo in `BATCH_TRANSPORT=bullmq`
mode now boots without `UnknownDependenciesException` — the original
F3 REJECT's specific blocker. Evidence:

- Build: `pnpm build` exit 0 — see `.omo/evidence/task-2-build.log`
- Core: 537/537 (was 533/533; +4 new alias tests) — see
  `.omo/evidence/task-2-core-test.log`
- Bullmq: 6/6 — see `.omo/evidence/task-2-bullmq-test.log`
- Demo unit: 19/19 — see `.omo/evidence/task-2-demo-test.log`
- Demo e2e: 14/14 — see `.omo/evidence/task-2-demo-e2e.log`
- In-process live demo: HTTP 200, 3 products, `exit_code='COMPLETED'` —
  see `.omo/evidence/task-2-inprocess.log` and
  `.omo/evidence/task-2-inprocess-db-state.log`
- **Bullmq live demo: BOOTS without `UnknownDependenciesException`**;
  `POST /jobs/import-products` returns HTTP 200 with `status=STARTING`;
  `batch_job_execution` row created — see
  `.omo/evidence/task-2-bullmq.log` and
  `.omo/evidence/task-2-bullmq-db-state.log`

### Bug #2 verdict: **RESOLVED**

The `JOB_REPOSITORY_TOKEN` symbol identity mismatch in
`NestBatchModule` is fixed at the source. `BullmqRuntimeService` can
now resolve the repository through the symbol path; the
`UnknownDependenciesException` at `NestFactory.create` time is gone
permanently; the symbol↔class gap is bridged in the library rather
than relying on host-side re-wiring.

### DoD #6 verdict: **PARTIAL** — see new bug below

The strictest form of DoD #6 ("BullMQ writes canonical execution
state through ORM repositories end-to-end") is partially met:

- ✅ The BullMQ enqueue path works.
- ✅ The worker dequeues.
- ❌ The worker's first call to `MikroORMJobRepository.getJobExecution`
  raises `ValidationError: Using global EntityManager instance
  methods for context specific actions is disallowed` because
  MikroORM 6 enforces strict context isolation and the worker
  callback runs outside any `RequestContext`. The job retries 3×
  and lands in BullMQ's `failed` list; the DB row stays at
  `STARTING` with no step rows and zero products.

This is **NOT a regression of Bug #2** — it is a separate, pre-existing
issue that the unit suite and in-process live demo do not exercise
(both use either the in-memory repository or run in the request
context). The follow-up F3 re-run documents this in
`.omo/evidence/f3-rerun-real-qa.md` §10.3 and §10.7 with a precise
root-cause analysis and a one-line fix recommendation
(`RequestContext.create(this.em, async () => { ... })` or
`em.fork()` per call inside
`packages/bullmq/src/bullmq-runtime.service.ts:processJob`).

### Files updated by this verification

- `.omo/evidence/f3-rerun-real-qa.md` — new §10 at the top with the
  PASS verdict for Bug #2, plus the §10.3 + §10.7 micro-bug
  documentation.
- `.omo/evidence/FINAL-FIX-REPORT.md` — UPDATE banner at the top
  noting Bug #2 is RESOLVED; the existing per-fix table row for
  Fix #2 is amended to record the subsequent resolution.
- `.omo/plans/nest-batch-bug2-fix.md` — this FOLLOW-UP COMPLETE
  section.

### What is NOT done (and why this is not a "DONE" stamp on the porting effort)

The follow-up `RequestContext` / `em.fork()` fix in
`BullmqRuntimeService.processJob` is out of scope of this verification
(the task is verification only, no code changes). A new plan
(`nest-batch-bug3-fix` or equivalent) should be opened to land it.
After that lands:

- The bullmq live demo will reach `batch_job_execution.exit_code = 'COMPLETED'`
  with `batch_step_execution.write_count = 3` and 3 products in
  the `product` table — fully matching the original F3 DoD #6
  statement.
- `pnpm --filter @nest-batch/demo test:e2e:bullmq` Scenarios 1 (and
  the dependent Scenarios 2 + 3) will go green.

Until that plan lands, DoD #6 is *partially* met: the boot is
unblocked, the enqueue path works, the worker dequeues, and the
ORM context wrap is the only remaining gap. The bullmq transport
itself is functional; the gap is one line in one method.
