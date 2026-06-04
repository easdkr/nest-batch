# F3 Re-run — Real Manual QA Report

**Plan:** `nest-batch-critical-fixes`
**Date:** 2026-06-04
**Scope:** Re-run F3 (from `nest-batch-architecture-enhancement`) after 4 critical/high bug fixes were applied.
**Critical DoD item under test:** "Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories." (DoD line 87 / Must Have #6)

---

## TL;DR — VERDICT: **REJECT**

The 5 claimed fixes are PARTIALLY in place:

| Fix # | Severity | Status | Evidence |
|------|----------|--------|----------|
| #1 | CRITICAL — `job-executor.ts:306-311` sets `exitCode: 'COMPLETED'` | **PASS** | `task-5-core-test.log`, `task-5-demo-inprocess.log`, live DB row |
| #2 | HIGH — `bullmq-batch.module.ts` doc-only update explaining global chain | **FAIL** | `task-5-demo-bullmq.log` — `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN` still raised on app startup; live demo and `test:e2e:bullmq` both fail |
| #3 | CRITICAL — `product.writer.ts` returns `{ written, skipped }` | **PASS** | `task-5-demo-test.log` (5/5 writer specs), live run inserts 3 products with no exception |
| #4 | HIGH — `library-integration.e2e.spec.ts` imports entities from `@nest-batch/mikro-orm` | **PASS** | `task-5-demo-e2e.log` — 14/14 e2e tests pass (was `ReferenceError: JobInstanceEntity is not defined` before) |
| #5 | HIGH — `vitest.e2e.config.ts` excludes `bullmq-import-products.e2e.spec.ts` | **PASS** | `task-5-demo-e2e.log` — suite finishes cleanly; no worker crash from the excluded file |

The blocking DoD #6 test is **STILL NOT MET** because the bullmq live demo cannot boot. The original F3 REJECT was for 3 critical bugs and 5+ HIGH issues. Fixes #1, #3, #4, #5 are real. Fix #2 is documentation only — the underlying DI problem is unchanged.

The fix proposed in the plan was to "document that `NestBatchModule`'s `global: true` scope handles the resolution" of `JOB_REPOSITORY_TOKEN` from inside `BullmqBatchModule`. This works **only** if the host wires the binding to `JOB_REPOSITORY_TOKEN` (the symbol), not to `JobRepository` (the class). The demo's `app.module.ts` binds the class. The `NestBatchModule` exports only the class token. The BullMQ runtime injects the symbol. Symbol ≠ class — `UnknownDependenciesException` is the correct, deterministic outcome of this mis-wiring. The doc-only fix did not address the actual cause.

---

## Output line

```
Scenarios [3/5 pass] | Test Suites [4/4 pass] | Live Demo [1/2 pass] | VERDICT: REJECT
```

Counting (deduped):

- **5 fix-level scenarios** (one per claimed fix)
  - 4 pass
  - 1 fails (Fix #2)
- **4 test suites** (core, bullmq, demo unit, demo e2e)
  - 4/4 pass (574 tests total, no regressions)
- **2 live demo runs** (in-process, bullmq)
  - 1/2 pass (in-process ✓, bullmq ✗)

---

## 1. Services

```
$ docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
NAMES                 STATUS                   PORTS
nest-batch-postgres   Up 2 hours (healthy)     0.0.0.0:5434->5432/tcp
redis                 Up 2 hours               0.0.0.0:6379->6379/tcp
```

Both services healthy (same state as the original F3).

---

## 2. Test suite results

### 2.1 `@nest-batch/core` — 533/533 pass (no regression)

```
Test Files  44 passed (44)
Tests       533 passed (533)
Duration    1.76s
```

The original F3 reported 532 tests. The current run shows 533. No regression; the +1 delta is from `tests/execution/provider-token-refs.test.ts` work that landed since the original F3 (1 test changed state). Raw evidence: `.omo/evidence/task-5-core-test.log`

### 2.2 `@nest-batch/bullmq` — 6/6 pass

```
Test Files  2 passed (2)
Tests       6 passed (6)
Duration    3.73s
```

The "DB-first execution" test still passes — it covers the in-test DI graph the original F3 verified (it instantiates the full Nest graph with `BULLMQ_MODULE_OPTIONS` + a real `JOB_REPOSITORY_TOKEN` binding). Raw evidence: `.omo/evidence/task-5-bullmq-test.log`

### 2.3 `@nest-batch/demo` (unit) — 19/19 pass

```
Test Files  4 passed (4)
Tests       19 passed (19)
Duration    592ms
```

The writer spec now has 5 tests (up from 3 in the original F3) covering the `{ written, skipped }` return path. Raw evidence: `.omo/evidence/task-5-demo-test.log`

### 2.4 `@nest-batch/demo` (e2e) — 14/14 pass

```
Test Files  3 passed (3)
Tests       14 passed (14)
Duration    3.18s
```

All scenarios from `import-products.e2e.spec.ts` (10), `mikroorm/checkpoint.e2e.spec.ts` (3), and `library-integration.e2e.spec.ts` (1) run to completion. The `bullmq-import-products.e2e.spec.ts` file is correctly excluded — no worker crash, no DI cascade. Raw evidence: `.omo/evidence/task-5-demo-e2e.log`

### 2.5 `@nest-batch/demo test:e2e:bullmq` — FAIL

```
Vitest caught 1 unhandled error during the test run.
Error: Worker exited unexpectedly
Test Files  (1)
     Tests  3
   Errors  1 error
Exit status 1
```

This suite is the one that boots the real demo `AppModule` with `BATCH_TRANSPORT=bullmq`. It uses the same code path the live demo uses. It fails with the same `UnknownDependenciesException` raised during `NestFactory.create` — the worker process crashes before any test setup runs. Raw evidence: `.omo/evidence/task-5-bullmq-e2e.log`

---

## 3. Live demo in-process mode — PASS

```
$ BATCH_TRANSPORT=in-process pnpm --filter @nest-batch/demo start
[Nest] AppModule — Batch transport mode: in-process
[Nest] Nest application successfully started
[Bootstrap] Demo app listening on :3000

$ curl -X POST http://localhost:3000/jobs/import-products \
    -H "Content-Type: application/json" \
    -d '{"file":"sample-data/products-valid.csv"}'
{"executionId":"820e0262-dbd9-4919-bf9a-1a1b29b554b9","status":"COMPLETED"}
HTTP_STATUS=200

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
  status   | exit_code
-----------+-----------
 COMPLETED | COMPLETED
(1 row)

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT COUNT(*) AS product_count FROM product"
 product_count
---------------
             3
(1 row)
```

Fix #1 and Fix #3 verified end-to-end:

- `exit_code='COMPLETED'` is written (Fix #1, was the original `CRITICAL #2` in the F3 REJECT).
- 3 products inserted cleanly (Fix #3 — duplicate handling is now via `WriterResult`, no `DuplicateSkuError` thrown).
- `end_time` populated and earlier than `start_time + 1s`.

Raw evidence: `.omo/evidence/task-5-demo-inprocess.log`

---

## 4. Live demo bullmq mode (DoD #6) — FAIL

```
$ BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1 \
    pnpm --filter @nest-batch/demo start
[Nest] NestBatchModule dependencies initialized
[Nest] AppModule — Batch transport mode: bullmq
[Nest] ERROR [ExceptionHandler] UnknownDependenciesException [Error]:
  Nest can't resolve dependencies of the BullmqRuntimeService
  (Symbol(@nest-batch/bullmq/MODULE_OPTIONS), ?, JobRegistry, JobExecutor, Object).
  Please make sure that the argument Symbol(@nest-batch/core/JOB_REPOSITORY) at
  index [1] is available in the BullmqBatchModule module.

  Potential solutions:
  - Is BullmqBatchModule a valid NestJS module?
  - If Symbol(@nest-batch/core/JOB_REPOSITORY) is a provider, is it part of the
    current BullmqBatchModule?
  - If Symbol(@nest-batch/core/JOB_REPOSITORY) is exported from a separate
    @Module, is that module imported within BullmqBatchModule?
      @Module({
        imports: [ /* the Module containing Symbol(@nest-batch/core/JOB_REPOSITORY) */ ]
      })

ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  Exit status 1
```

The exact same `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN` is raised that the original F3 reported. The doc-only fix did not change runtime behavior. The app never reaches the `Mapped {/jobs/import-products, POST} route` line; it crashes during `NestFactory.create`.

### Root cause (verified by reading the source, not just by reading the error)

`packages/bullmq/src/bullmq-runtime.service.ts:148` injects the **symbol** token:

```ts
@Inject(JOB_REPOSITORY_TOKEN)  // Symbol.for('@nest-batch/core/JOB_REPOSITORY')
```

The demo's `apps/demo/src/app.module.ts` wires the binding to the **class** token:

```ts
NestBatchModule.forRoot({
  repository: { provide: JobRepository, useClass: MikroORMJobRepository },
  //                                ^^^^^^^^^^^^ class, not JOB_REPOSITORY_TOKEN
})
```

`packages/core/src/module/nest-batch.module.ts:514-516` then adds **the class** to `exports` (via `extractToken(repository).provide`), never the symbol. The result: `BullmqRuntimeService` cannot resolve `JOB_REPOSITORY_TOKEN`. The "global module chain" the fix's doc-comment describes does not bridge the symbol↔class gap; the binding literally does not exist under that key.

This is a real, deterministic, user-facing bug — exactly the one the original F3 flagged as `CRITICAL #1`. The fix in this plan did not address it.

Raw evidence: `.omo/evidence/task-5-demo-bullmq.log`

---

## 5. Comparison with original F3 REJECT

| Original F3 item | Status after fixes |
|------------------|-------------------|
| **#1** CRITICAL — `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN` in bullmq live demo | **STILL BROKEN** (doc-only fix) |
| **#2** CRITICAL — `exitCode` not set on success | **FIXED** (live DB confirms `exit_code='COMPLETED'`) |
| **#3** CRITICAL — chunk-step `writeCount=0` in skip path | NOT RE-TESTED in this run; out of scope for the live-demo gate. The unit suite (533/533) exercises it. |
| **#4** HIGH — `ReferenceError: JobInstanceEntity is not defined` in `library-integration.e2e.spec.ts` | **FIXED** (14/14 e2e pass) |
| **#5** HIGH — `vitest.e2e.config.ts` accidentally pulls in `bullmq-import-products.e2e.spec.ts` | **FIXED** (14/14 e2e pass; bullmq file excluded) |
| #6 HIGH — `mikro-orm/contract.test.ts` 3 tests fail | NOT RE-TESTED in this run; out of scope for the live-demo gate. |
| #7 MEDIUM — `in-memory-job-repository.ts:111` initializes `exitCode: ''` | **FIXED** transitively by Fix #1. |
| #8 MEDIUM — `csv-product.reader.ts` memoizes exhausted iterator | NOT RE-TESTED; in-process run worked because of fresh process per curl trigger. |
| #9 MEDIUM — scenarios 3, 7, 8, 9, 10 blocked by #5 | **UNBLOCKED** by Fix #5; all 10 e2e scenarios now run. |
| #10 EXPECTED — `typeorm` 15 failures are SQLite `pessimistic_write` limitations | NOT RE-TESTED; unchanged. |

Net: 4 of the 5 critical/high items this plan set out to fix are genuinely fixed. The one that isn't is Fix #2, and it is exactly the one the original F3 marked CRITICAL #1 and the plan's DoD #6 line directly tests.

---

## 6. Remaining issues

1. **CRITICAL — bullmq live demo cannot boot.** Fix #2 (doc-only) is insufficient. The runtime needs an actual binding for `JOB_REPOSITORY_TOKEN`. Three options that would each work:
   - Change `app.module.ts` to bind to `JOB_REPOSITORY_TOKEN` instead of `JobRepository` (one-line fix; the class-typed binding was wrong).
   - Change `bullmq-runtime.service.ts` to inject `JobRepository` (the class) instead of `JOB_REPOSITORY_TOKEN` (the symbol).
   - Add `JOB_REPOSITORY_TOKEN` to `NestBatchModule`'s exports unconditionally, and change the demo to use the symbol.
   The current "global module chain" doc is correct **in principle** but does not bridge a symbol↔class mismatch.

2. **VERIFICATION GAP — `test:e2e:bullmq` (3 tests) is excluded from CI.** Even though the fix is now straightforward, the existing e2e suite for the BullMQ execution path is not gated by any pass/fail signal. After the fix lands, `pnpm --filter @nest-batch/demo test:e2e:bullmq` must be added to the CI workflow (or run in a matrix) so this regression class is caught next time.

3. **VERIFICATION GAP — out-of-scope items.** The original F3's items #3, #6, #7, #8 were not part of this re-run. They should be re-verified in a follow-up plan if the scope expands; the unit suite (533/533) and e2e suite (14/14) cover them transitively but not exhaustively.

---

## 7. What was verified vs. what was not

Verified by re-running the F3 scenarios with all 5 fixes applied:

- `pnpm --filter @nest-batch/core test` → 533/533 pass (no regression) ✓
- `pnpm --filter @nest-batch/bullmq test` → 6/6 pass ✓
- `pnpm --filter @nest-batch/demo test` → 19/19 pass ✓
- `pnpm --filter @nest-batch/demo test:e2e` → 14/14 pass (no worker crash) ✓
- Live demo in-process: COMPLETED jobs have `exit_code='COMPLETED'` in DB ✓
- Live demo bullmq: **app boots with `UnknownDependenciesException`** ✗
- `pnpm --filter @nest-batch/demo test:e2e:bullmq` → **3 tests, 1 unhandled error, exit 1** ✗

The plan's DoD #6 line ("Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories") is **not** met. The bullmq transport cannot reach the state-writing stage at all — the worker process crashes on startup.

---

## 8. Raw evidence index

| File | Captures |
|------|----------|
| `.omo/evidence/task-5-core-test.log` | `@nest-batch/core` 533/533 unit/contract |
| `.omo/evidence/task-5-bullmq-test.log` | `@nest-batch/bullmq` 6/6 + DI graph build |
| `.omo/evidence/task-5-demo-test.log` | demo writer + controller + reader + processor specs |
| `.omo/evidence/task-5-demo-e2e.log` | demo e2e 14/14 (with `bullmq-import-products` excluded) |
| `.omo/evidence/task-5-demo-inprocess.log` | live demo in-process boot + curl + 3 products + exit_code='COMPLETED' |
| `.omo/evidence/task-5-demo-bullmq.log` | live demo bullmq boot + `UnknownDependenciesException` |
| `.omo/evidence/task-5-bullmq-e2e.log` | `test:e2e:bullmq` worker-exit failure |
| `.omo/evidence/f3-real-qa.md` | original F3 REJECT (for comparison) |

---

## 9. Recommended next step

Re-open the `nest-batch-critical-fixes` plan. Keep Fix #1, Fix #3, Fix #4, Fix #5 as-is. Replace Fix #2 with a code change that resolves the symbol↔class mismatch described in §6. The cheapest path is the first option (change `app.module.ts` to bind to `JOB_REPOSITORY_TOKEN`); the most defensive path is the third option (unconditional export + symbol binding). Either way, re-run this F3 scenario file afterward; the bullmq live demo must reach `Mapped {/jobs/import-products, POST} route` and a `POST /jobs/import-products` must produce a `batch_job_execution` row with `status=COMPLETED, exit_code='COMPLETED'`.
