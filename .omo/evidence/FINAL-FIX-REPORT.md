# nest-batch Critical Fixes — Final Report

## UPDATE — 2026-06-04 19:30 PT — Bug #2 RESOLVED via core token aliasing

The follow-up plan `nest-batch-bug2-fix` (see
`.omo/plans/nest-batch-bug2-fix.md`) implemented Option C from
§"Remaining Work" below: `NestBatchModule` now auto-aliases
`JOB_REPOSITORY_TOKEN` to the user-chosen repository token via
`useExisting`, and re-exports the symbol so symbol-based consumers
(like `BullmqRuntimeService`) resolve regardless of how the host
bound the repository. The follow-up F3 re-run
(`.omo/evidence/f3-rerun-real-qa.md` §10) verifies the fix:

- `pnpm --filter @nest-batch/core test` → **537/537** (was 533/533 — the +4 are the new alias tests)
- `pnpm --filter @nest-batch/bullmq test` → **6/6**
- `pnpm --filter @nest-batch/demo test` → **19/19**
- `pnpm --filter @nest-batch/demo test:e2e` → **14/14**
- `pnpm build` → exit 0
- Live demo in `BATCH_TRANSPORT=bullmq` mode: **BOOTS without `UnknownDependenciesException`** (was the F3 REJECT symptom)
- Live demo in `BATCH_TRANSPORT=bullmq` mode: `POST /jobs/import-products` returns **HTTP 200** with `{"status":"STARTING"}`
- Live demo in `BATCH_TRANSPORT=bullmq` mode: `batch_job_execution` row created at `status=STARTING`

**Bug #2: NOW RESOLVED.** The original F3 REJECT was specifically
about the `UnknownDependenciesException` raised during
`NestFactory.create()` for `JOB_REPOSITORY_TOKEN`. That exception is
no longer raised — `grep -c "UnknownDependenciesException"
/tmp/demo-bullmq.log` returns `0`. The `BullmqBatchModule` is
initialized, the `BullmqRuntimeService` is started, the
`BullmqRuntimeService` enqueues real BullMQ jobs on
`POST /jobs/import-products`, and the worker dequeues them.

**One caveat surfaced by the re-run (NOT a regression of Bug #2,
NOT what the original F3 REJECT was about):** the worker then fails
on its first `MikroORMJobRepository.getJobExecution()` call with
`ValidationError: Using global EntityManager instance methods for
context specific actions is disallowed`. This is a pre-existing
issue in the worker → ORM path that the unit suite
(`InMemoryJobRepository` only) and the in-process live demo do not
exercise. The fix is a one-liner in
`BullmqRuntimeService.processJob` (wrap the body in
`RequestContext.create(this.em, ...)` or use `em.fork()` per call).
The F3 rerun documents this in §10.3 and §10.7 with a clear
"FOLLOW-UP REQUIRED" note. DoD #6 ("Redis + DB e2e proves BullMQ
transport writes canonical execution state through ORM
repositories") is therefore *partially* met — the boot is
unblocked, the enqueue path works, the worker dequeues, but the
final ORM write is gated by the new (separate) context issue.

The plan file at `.omo/plans/nest-batch-bug2-fix.md` has been
amended with a "FOLLOW-UP COMPLETE" section that records the same
outcome.

---

**Plan:** `nest-batch-critical-fixes`
**Date:** 2026-06-04
**Status:** PARTIAL — 4 of 5 fixes verified, DoD #6 still blocked by Fix #2

---

## Executive Summary

The `nest-batch-critical-fixes` plan set out to resolve the 3 CRITICAL bugs and 2 HIGH issues flagged by the original F3 Real Manual QA against the `nest-batch-architecture-enhancement` release, with the explicit goal of unblocking DoD #6 (Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories). Of the 5 fixes attempted, **4 are real and verified** — Bug #1 (JobExecutor `exitCode='COMPLETED'`), Bug #3 (ProductWriter `WriterResult`), Bug #4 (library-integration import), and Bug #5 (vitest.e2e.config exclude) all hold under re-test. The 5th, **Bug #2 (BullmqBatchModule DI for `JOB_REPOSITORY_TOKEN`)**, was implemented as a doc-only comment update rather than a code change, and the live demo in `BATCH_TRANSPORT=bullmq` mode still fails with `UnknownDependenciesException` at `NestFactory.create` time. The in-process live demo is fully green (3 products inserted, `status=COMPLETED`, `exit_code='COMPLETED'`) and the entire test pyramid passes with no regressions (533 core + 6 bullmq + 19 demo unit + 14 demo e2e = 572 tests), but **DoD #6 remains unmet** and a follow-up code change is required before this plan can be marked DONE.

---

## Bug Status Table

| Fix # | Original F3 # | Severity | File / Area | What was claimed | Actual outcome | Evidence |
|-------|---------------|----------|-------------|------------------|----------------|----------|
| **#1** | CRITICAL #2 | CRITICAL | `packages/core/src/execution/job-executor.ts:306-311` | Set `exitCode: 'COMPLETED'` on the success path so COMPLETED jobs do not leave `exit_code=''` in the DB | **FIXED** — live DB row after `POST /jobs/import-products` shows `status=COMPLETED, exit_code='COMPLETED'`; new test in `job-executor.test.ts` passes; bullmq "DB-first execution" test still passes | `task-5-core-test.log`, `task-5-demo-inprocess.log` (live `psql` output) |
| **#2** | CRITICAL #1 | HIGH (in this plan) | `packages/bullmq/src/bullmq-batch.module.ts` | Add a doc comment explaining that `global: true` on `NestBatchModule` resolves `JOB_REPOSITORY_TOKEN` inside `BullmqBatchModule`'s DI scope | **NOT FIXED (in this plan)** — the doc-only change does not bridge a symbol↔class mismatch. `BullmqRuntimeService` injects `@Inject(JOB_REPOSITORY_TOKEN)` (a symbol), the demo binds `{ provide: JobRepository, useClass: MikroORMJobRepository }` (a class), and `NestBatchModule` exports only the class token. `UnknownDependenciesException` is still raised during `NestFactory.create` for `BATCH_TRANSPORT=bullmq` mode. **SUBSEQUENTLY RESOLVED in `nest-batch-bug2-fix`** via `useExisting` alias + re-export of the symbol in `NestBatchModule.buildProviders` and `forRoot()` / `forRootAsync()`. The follow-up F3 re-run (`.omo/evidence/f3-rerun-real-qa.md` §10) confirms `UnknownDependenciesException` count = 0 in the bullmq live demo log. | `task-5-demo-bullmq.log`, `task-5-bullmq-e2e.log`, `f3-rerun-real-qa.md` §4 + §6, `f3-rerun-real-qa.md` §10 |
| **#3** | CRITICAL #3 | CRITICAL | `apps/demo/src/jobs/import-products/writer/product.writer.ts` | Return `{ written, skipped }` from `write()` instead of throwing `DuplicateSkuError` on the first duplicate SKU | **FIXED** — `product.writer.ts` now returns a `WriterResult`; chunk is no longer aborted on a duplicate; live run inserts 3 products cleanly with no exception; 5/5 writer specs pass (up from 3) | `task-5-demo-test.log`, `task-5-demo-inprocess.log` |
| **#4** | HIGH #4 | HIGH | `apps/demo/tests/e2e/library-integration.e2e.spec.ts:135` | Add the missing import for `JobInstanceEntity` so the `ReferenceError` is gone | **FIXED** — `library-integration.e2e.spec.ts` now runs to completion as part of the e2e suite; 14/14 demo e2e tests pass | `task-5-demo-e2e.log` |
| **#5** | HIGH #5 | HIGH | `apps/demo/vitest.e2e.config.ts` | Exclude `bullmq-import-products.e2e.spec.ts` from the default e2e glob so the suite finishes cleanly without a worker crash | **FIXED** — `bullmq-import-products.e2e.spec.ts` is no longer picked up by `test:e2e`; the e2e suite runs 14/14 green with no worker crash; the bullmq suite is invoked via the separate `test:e2e:bullmq` script | `task-5-demo-e2e.log`, `task-5-bullmq-e2e.log` |

**Net result:** 4 of 5 fixes verified. The plan did **not** unblock DoD #6 because Fix #2, the very one the original F3 marked CRITICAL #1 and on which DoD #6 is gated, was treated as documentation rather than a code change. **The follow-up `nest-batch-bug2-fix` plan closed that gap** (see the UPDATE at the top of this file).

---

## Test Results Summary

| Suite | Scope | Result | Notes |
|-------|-------|--------|-------|
| `pnpm --filter @nest-batch/core test` | 44 files, all unit + contract specs | **533/533 pass** in 1.76s | +1 test vs. original F3 (532) — delta is from `tests/execution/provider-token-refs.test.ts` work that landed after the original F3. No regression. |
| `pnpm --filter @nest-batch/bullmq test` | 2 files, incl. the "DB-first execution" DI-graph test | **6/6 pass** in 3.73s | The "DB-first execution" test instantiates the full Nest graph with a real `JOB_REPOSITORY_TOKEN` binding and therefore does **not** exercise the demo's mis-wired `app.module.ts`. Its green pass is necessary but not sufficient. |
| `pnpm --filter @nest-batch/demo test` | 4 files, writer / controller / reader / processor specs | **19/19 pass** in 592ms | Writer spec grew from 3 to 5 tests, covering the `WriterResult` return path that landed in Fix #3. |
| `pnpm --filter @nest-batch/demo test:e2e` | 3 files, `import-products` (10) + `mikroorm/checkpoint` (3) + `library-integration` (1) | **14/14 pass** in 3.18s | The previously excluded `bullmq-import-products.e2e.spec.ts` is correctly filtered out by Fix #5. No worker crash. |
| `pnpm --filter @nest-batch/demo test:e2e:bullmq` | `bullmq-import-products.e2e.spec.ts` (3 tests) | **FAIL (in this plan) — STILL FAILS after `nest-batch-bug2-fix`, but the failure mode has changed** | This is the suite that boots the real demo `AppModule` with `BATCH_TRANSPORT=bullmq`. Pre-`bug2-fix`: crashes during `NestFactory.create` with `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN`. Post-`bug2-fix`: app boots, worker dequeues, then fails on `MikroORMJobRepository.getJobExecution()` with `ValidationError: Using global EntityManager instance methods for context specific actions is disallowed`. The new failure is documented in `f3-rerun-real-qa.md` §10.3 — it is a separate bug in the worker → ORM context path, NOT a regression of Bug #2. |
| **Live demo — in-process mode** | `BATCH_TRANSPORT=in-process` + `POST /jobs/import-products` + `psql` | **PASS** — `status=COMPLETED, exit_code='COMPLETED'`, 3 products in `product` table | Verifies Fix #1 and Fix #3 end-to-end. |
| **Live demo — bullmq mode (DoD #6 gate)** | `BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1` | **PARTIAL** — bug #2 (the original F3 REJECT cause) is **NOW FIXED**; the app boots, the `POST /jobs/import-products` returns 200 with `status=STARTING`, and a `batch_job_execution` row is created. A **NEW** issue (not in scope of this plan or of `nest-batch-bug2-fix`) is uncovered at the worker→ORM step: `ValidationError: Using global EntityManager instance methods for context specific actions is disallowed` raised inside the BullMQ worker's `processJob` callback when it calls `MikroORMJobRepository.getJobExecution`. The job retries 3× and ends up in BullMQ's `failed` list; the DB row stays at `STARTING` with no step execution rows and zero products. Fix is a one-liner in `BullmqRuntimeService.processJob` (`RequestContext.create(this.em, ...)` or `em.fork()` per call). See `f3-rerun-real-qa.md` §10.3 and §10.7. | This is the unblocking gate. The original blocker (Bug #2 / DI token identity) is FIXED; a separate, narrower bug remains. |

**Totals:** 572 tests pass with zero regressions across the four green suites. The bullmq live demo and the `test:e2e:bullmq` script both fail with the same `UnknownDependenciesException` raised at startup, which is the original F3 CRITICAL #1 returning unchanged. **(Updated after `nest-batch-bug2-fix`: the four green suites now show 537/537 + 6/6 + 19/19 + 14/14 = 576 tests passing, and the bullmq live demo no longer fails with `UnknownDependenciesException`. The remaining failure is a SEPARATE, NEW bug at the worker→ORM context step — see the UPDATE at the top of this file.)**

---

## Remaining Work

1. **CRITICAL — actually fix Bug #2 (BullmqBatchModule DI).** The original F3 marked this as CRITICAL #1. The doc-only fix in this plan did not address the cause. Three viable code-level options:
   - **Option A (cheapest):** Change `apps/demo/src/app.module.ts` to bind the repository to the symbol — `{ provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository }` — instead of `{ provide: JobRepository, useClass: MikroORMJobRepository }`. The class-typed binding was the wrong key. One-line change in the demo; no library changes required.
   - **Option B (defensive at the library boundary):** Change `packages/bullmq/src/bullmq-runtime.service.ts` to inject the `JobRepository` class token instead of `@Inject(JOB_REPOSITORY_TOKEN)`. This aligns the runtime with what the demo (and any other consumer) already wires. Requires care so that consumers who already bind to the symbol still resolve.
   - **Option C (most defensive, library-side):** Add `JOB_REPOSITORY_TOKEN` to `NestBatchModule`'s `exports` unconditionally, and change the demo to use the symbol. Makes the contract explicit on the library side and prevents the mismatch from recurring in any future consumer.
   - **Recommendation:** Option A for the immediate unblock (smallest diff, fastest to verify). Option C if there is appetite to harden the library contract so this regression class cannot reappear in another host application. After either, add a regression test that boots `AppModule` with `BATCH_TRANSPORT=bullmq` against real Postgres + Redis.

2. **Verification gap — `test:e2e:bullmq` is not gated in CI.** The script exists and is correct; the issue is that it is not part of the default CI matrix. After the Fix #2 follow-up lands, `pnpm --filter @nest-batch/demo test:e2e:bullmq` should be added to `.github/workflows/ci.yml` (with `services: postgres, redis`) so this regression class is caught at PR time, not in a manual F3 rerun.

3. **Scope coverage — items #3, #6, #7, #8 from the original F3 were not retested live.** They are covered transitively by the 533-test unit suite and the 14-test e2e suite, but not exhaustively. If the plan is extended, a focused re-run that re-exercises `mikro-orm` FOR UPDATE SKIP LOCKED concurrency and the reader iterator memoization is worth doing in a separate verification pass.

4. **Plan hygiene — mark Task 2 as not actually completed.** The plan file currently shows `Task 2: Fix #2` as `[x]` (checked). That is misleading — only the doc comment was added. This report and the `FOLLOW-UP REQUIRED` section appended to the plan file are the explicit record that Fix #2 is not done.

---

## Final Verdict on the Plan

**VERDICT: PARTIAL — REOPEN REQUIRED FOR FIX #2.** *(Updated below after the follow-up plan landed.)*

The plan accomplished most of what it set out to do: it fixed 4 of the 5 bugs cleanly, produced a stable test pyramid (572 tests pass, zero regressions), and turned the in-process live demo green. The work is real, the commits are real, and the evidence is captured. However, the plan **did not unblock DoD #6**, which was its explicit headline goal. The single failure (Fix #2) is exactly the one DoD #6 is gated on, and the failure is the same one the original F3 reported verbatim — `UnknownDependenciesException` for `Symbol(@nest-batch/core/JOB_REPOSITORY)` in `BullmqRuntimeService` during app bootstrap.

This is not a flaky-test or a CI-infrastructure problem. It is a code-level bug that this plan documented but did not change. Until Fix #2 receives an actual code change (any of Options A / B / C above) and the bullmq live demo + `test:e2e:bullmq` go green, the plan cannot be marked complete and the `nest-batch-architecture-enhancement` release cannot be promoted out of REJECT.

A new plan — or at minimum a new task in this plan — is required to:

- pick one of the three Fix #2 options,
- land the corresponding code change + regression test,
- re-run the F3 live-demo bullmq scenario and `test:e2e:bullmq` to confirm the green path,
- update CI to gate `test:e2e:bullmq` so this regression class is caught earlier next time.

Until that follow-up lands, treat this plan as: **4/5 bugs fixed, DoD #6 NOT met, release remains REJECT.**

### Update after `nest-batch-bug2-fix` (2026-06-04 19:30 PT)

**Bug #2 is NOW RESOLVED** (via the third option above: `useExisting` alias + symbol re-export in `NestBatchModule`).

- The bullmq live demo no longer raises `UnknownDependenciesException`. It boots through `NestFactory.create`, registers the route, starts the `BullmqRuntimeService`, enqueues a real BullMQ job on `POST /jobs/import-products`, and the worker dequeues it.
- The `test:e2e:bullmq` failure mode has changed from "worker crashed at startup" to "worker started, dequeued, and then failed on the first repository call". The new error is a separate, pre-existing issue in the BullMQ worker → MikroORM context path that no test in the existing pyramid (which all use `InMemoryJobRepository` for the bullmq path) had exercised.
- DoD #6 in the strictest sense ("BullMQ writes canonical execution state through ORM repositories") is therefore *partially* met: the boot is unblocked, the enqueue path works, the worker dequeues, but the final ORM write is gated by the new (separate) context issue.

Recommended next step: open a new plan `nest-batch-bug3-fix` (or equivalent) to land the one-line `RequestContext.create(this.em, ...)` wrap in `BullmqRuntimeService.processJob`. After that lands, DoD #6 will be fully met and the entire `nest-batch-architecture-enhancement` porting effort can be marked DONE.

---

## Evidence Index

| File | Contents |
|------|----------|
| `.omo/evidence/f3-rerun-real-qa.md` | The full F3 re-run report this final report summarizes (274 lines). |
| `.omo/evidence/task-5-core-test.log` | `@nest-batch/core` 533/533 unit + contract. |
| `.omo/evidence/task-5-bullmq-test.log` | `@nest-batch/bullmq` 6/6 incl. "DB-first execution". |
| `.omo/evidence/task-5-demo-test.log` | Demo writer + controller + reader + processor specs (19/19). |
| `.omo/evidence/task-5-demo-e2e.log` | Demo e2e 14/14, with `bullmq-import-products` excluded. |
| `.omo/evidence/task-5-demo-inprocess.log` | Live demo in-process boot + curl + 3 products + `exit_code='COMPLETED'`. |
| `.omo/evidence/task-5-demo-bullmq.log` | Live demo bullmq boot + `UnknownDependenciesException`. |
| `.omo/evidence/task-5-bullmq-e2e.log` | `test:e2e:bullmq` worker-exit failure. |
| `.omo/plans/nest-batch-critical-fixes.md` | The plan file, now with an appended `FOLLOW-UP REQUIRED` section. |
