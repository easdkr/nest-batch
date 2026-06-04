# F3 Re-run — Real Manual QA Report

## F3 RERUN — VERDICT: **PASS** (Bug #2 fix verified) — 2026-06-04 19:30 PT

This re-run was triggered after `nest-batch-bug2-fix` applied the
`JOB_REPOSITORY_TOKEN` alias fix in `packages/core/src/module/nest-batch.module.ts`.
The originally-failing F3 scenario (live demo in `BATCH_TRANSPORT=bullmq` mode
crashing on startup with `UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN`)
is now **VERIFIED FIXED**:

- `UnknownDependenciesException` count in the bullmq live demo log: **0**
- `Nest application successfully started`: **present**
- `BullmqRuntimeService started`: **present**
- `Mapped {/jobs/import-products, POST} route`: **present**
- `POST /jobs/import-products` returns **HTTP 200** with `{"status":"STARTING"}`
- `batch_job_execution` row created (status=STARTING, not the prior crash)
- All four test suites stay green: **537/537 core, 6/6 bullmq, 19/19 demo, 14/14 e2e**

**Caveat (new issue uncovered, NOT part of Bug #2):** The BullMQ worker
fails on the first `MikroORMJobRepository.getJobExecution()` call with
`ValidationError: Using global EntityManager instance methods for context
specific actions is disallowed`. The job retries 3x and ends up in
the BullMQ `failed` list; the DB row stays at `STARTING` with no step
execution rows and zero products written. The fix proposed in
`nest-batch-bug2-fix.md` solved the DI token identity issue (the F3
rejection's specific blocker) but did NOT address the worker→ORM
context. DoD #6 in the strictest sense ("BullMQ writes canonical
state through ORM repositories") is therefore still partially open.
The fix here is a one-line `RequestContext.create(em, ...)` (or
`em.fork()`) wrap in the `BullmqRuntimeService.processJob` callback —
see "FOLLOW-UP REQUIRED" section at the bottom of this file.

Raw evidence for this re-run:
- `.omo/evidence/task-2-build.log`
- `.omo/evidence/task-2-all-tests.log`
- `.omo/evidence/task-2-core-test.log`
- `.omo/evidence/task-2-bullmq-test.log`
- `.omo/evidence/task-2-demo-test.log`
- `.omo/evidence/task-2-demo-e2e.log`
- `.omo/evidence/task-2-bullmq-e2e.log`
- `.omo/evidence/task-2-inprocess.log` (in-process live demo — PASS)
- `.omo/evidence/task-2-inprocess-db-state.log`
- `.omo/evidence/task-2-bullmq.log` (bullmq live demo — boot PASS, worker fail)
- `.omo/evidence/task-2-bullmq-db-state.log`
- `.omo/evidence/task-2-bullmq-failed-reason.log` (the new MikroORM context error)

---

**Plan (original):** `nest-batch-critical-fixes`
**Plan (follow-up):** `nest-batch-bug2-fix`
**Date (original rerun):** 2026-06-04 17:00 PT
**Date (this rerun):** 2026-06-04 19:30 PT
**Scope:** Re-run F3 (from `nest-batch-architecture-enhancement`) after
`nest-batch-bug2-fix` applied the JOB_REPOSITORY_TOKEN alias in core.
**Critical DoD item under test:** "Redis + DB e2e proves BullMQ transport writes canonical execution state through ORM repositories." (DoD line 87 / Must Have #6)

---

## TL;DR — VERDICT: **REJECT** (F3 of `nest-batch-critical-fixes`, prior to this re-run)

The 5 claimed fixes in the `nest-batch-critical-fixes` plan were PARTIALLY in place:

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

## Output line (prior F3 rerun)

```
Scenarios [3/5 pass] | Test Suites [4/4 pass] | Live Demo [1/2 pass] | VERDICT: REJECT
```

## Output line (this F3 rerun — after `nest-batch-bug2-fix`)

```
Scenarios [1/1 bug-2-fix verified] | Test Suites [4/4 pass] | Live Demo [1/2 boot pass, 1/2 state-write fail] | BUG #2: RESOLVED | DoD #6: PARTIAL
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

---

## 10. Re-run after `nest-batch-bug2-fix` (2026-06-04 19:30 PT)

### 10.1 What changed

`packages/core/src/module/nest-batch.module.ts` now auto-aliases
`JOB_REPOSITORY_TOKEN` to the user-provided repository token via
`useExisting` in `buildProviders()`. Both `forRoot()` and `forRootAsync()`
also export `JOB_REPOSITORY_TOKEN` when the host's chosen token differs
from the canonical symbol. The demo `apps/demo/src/app.module.ts` was
NOT touched — the fix is library-side, not host-side. This is exactly
Option C from the prior F3 rerun's "Recommended next step" section,
landed as a new plan (`nest-batch-bug2-fix.md`).

The new test in `packages/core/tests/module/nest-batch.module.spec.ts`
covers both directions of the alias:

- `repository: { provide: JobRepository, useClass: X }` → both
  `JobRepository` and `JOB_REPOSITORY_TOKEN` resolve to the same X
  instance.
- `repository: { provide: JOB_REPOSITORY_TOKEN, useClass: Y }` → no
  duplicate provider (idempotent).

Four new tests, all green. Core suite is now **537/537** (was 533/533).

### 10.2 Live demo in BATCH_TRANSPORT=bullmq — boot (was the F3 REJECT)

```
$ BATCH_TRANSPORT=bullmq BATCH_BULLMQ_AUTOSTART_WORKER=1 BATCH_BULLMQ_KEY_PREFIX=nest-batch-task2: \
    pnpm --filter @nest-batch/demo start
[Nest] AppModule — Batch transport mode: bullmq
[Nest] NestFactory — Starting Nest application... +69ms
[Nest] InstanceLoader — AppConfigModule dependencies initialized +10ms
[Nest] InstanceLoader — NestBatchMikroOrmModule dependencies initialized +0ms
[Nest] InstanceLoader — ConfigHostModule dependencies initialized +8ms
[Nest] InstanceLoader — DiscoveryModule dependencies initialized +0ms
[Nest] InstanceLoader — ConfigModule dependencies initialized +4ms
[Nest] InstanceLoader — MikroOrmCoreModule dependencies initialized +16ms
[Nest] InstanceLoader — NestBatchModule dependencies initialized +0ms
[Nest] InstanceLoader — BullmqBatchModule dependencies initialized +0ms   ← was the failure point
[Nest] InstanceLoader — AppModule dependencies initialized +0ms
[Nest] RoutesResolver — BatchController {/jobs}: +2ms
[Nest] RouterExplorer — Mapped {/jobs/import-products, POST} route +1ms
[Nest] BullmqRuntimeService — BullmqRuntimeService started: queue="nest-batch-work" worker=auto, keyPrefix="nest-batch-task2:"
[Nest] BullmqScheduleService — BullmqScheduleService started: queue="nest-batch-schedule" schedules=0/0 (skipped=0 inert)
[Nest] ImportProductsJobRegistrar — Registered job "import-products" with filePath=sample-data/products-valid.csv
[Nest] NestApplication — Nest application successfully started +0ms
[Nest] Bootstrap — Demo app listening on :3000
[Nest] BullmqRuntimeService — Enqueued step "validate-csv" for execution 23b831db-... as BullMQ job 1
```

```
$ grep -c "UnknownDependenciesException" /tmp/demo-logs/bullmq.log
0

$ curl -X POST http://localhost:3000/jobs/import-products \
    -H "Content-Type: application/json" \
    -d '{"file":"sample-data/products-valid.csv"}'
{"executionId":"23b831db-8d8b-45b1-b3d4-66553ddd826d","status":"STARTING"}
HTTP_STATUS=200

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT id, status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 3"
                  id                  |  status  | exit_code
--------------------------------------+----------+-----------
 23b831db-8d8b-45b1-b3d4-66553ddd826d | STARTING |
(1 row)
```

**The F3 rejection's specific failure mode is GONE.** The
`UnknownDependenciesException` for `JOB_REPOSITORY_TOKEN` that the
prior F3 reported on `NestFactory.create()` is no longer raised.
The `BullmqBatchModule` resolves, the `BullmqRuntimeService` starts,
the worker boots, the `Mapped {/jobs/import-products, POST} route`
is registered, and the `POST /jobs/import-products` enqueues a real
BullMQ job (ID 1) that the worker dequeues.

Raw evidence: `.omo/evidence/task-2-bullmq.log`, `.omo/evidence/task-2-bullmq-db-state.log`.

### 10.3 Live demo in BATCH_TRANSPORT=bullmq — worker execution (NEW ISSUE)

After the worker dequeues the BullMQ job, the call chain
`Worker.processFn` → `BullmqRuntimeService.processJob` →
`MikroORMJobRepository.getJobExecution` raises:

```
ValidationError: Using global EntityManager instance methods for
context specific actions is disallowed. If you need to work with the
global instance's identity map, use `allowGlobalContext` configuration
option or `fork()` instead.
    at SqlEntityManager.getContext (...)
    at SqlEntityManager.findOne (JobExecutionEntity)
    at MikroORMJobRepository.getJobExecution (packages/mikro-orm/src/mikroorm-job-repository.ts:174)
    at BullmqRuntimeService.processJob (packages/bullmq/src/bullmq-runtime.service.ts:289)
    at Worker.processFn (...)
```

BullMQ retries the job 3× (the package's `defaultJobOptions.attempts: 3`)
and on the third failure moves it to the `failed` list. The DB row
created at enqueue time stays at `status=STARTING, exit_code=''`;
no `batch_step_execution` row is ever written; the `product` table
remains empty.

```
$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT step_name, status, exit_code, read_count, write_count, skip_count FROM batch_step_execution ORDER BY id DESC LIMIT 3"
 step_name | status | exit_code | read_count | write_count | skip_count
-----------+--------+-----------+------------+-------------+------------
 (0 rows)

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT COUNT(*) AS product_count FROM product"
 product_count
---------------
             0
(1 row)

$ docker exec redis redis-cli HGET "nest-batch-task2::nest-batch-work:1" failedReason
Using global EntityManager instance methods for context specific actions is disallowed...
```

#### Why this is NOT a regression of Bug #2

The `nest-batch-bug2-fix` plan was scoped to "the symbol↔class token
identity mismatch in `NestBatchModule`'s `exports` list". That mismatch
is fixed. The new error is in a completely different code path:

- Bug #2 was: `NestBatchModule` did not register or export
  `JOB_REPOSITORY_TOKEN` when the host bound the repository to a class
  token (`JobRepository`). Result: `BullmqRuntimeService`'s
  `@Inject(JOB_REPOSITORY_TOKEN)` parameter could not be resolved at
  module build time → `UnknownDependenciesException` raised during
  `NestFactory.create()`.

- The new error is: `BullmqRuntimeService.processJob` (which is now
  correctly resolving the `JobRepository` instance) calls
  `MikroORMJobRepository.getJobExecution`, which uses
  `this.em.findOne(...)` against the global `EntityManager` (the one
  bound at `MikroOrmModule.forRoot()` registration time). MikroORM 6
  enforces strict context isolation: the BullMQ worker's callback
  runs outside any `RequestContext`, so the global-EM call is
  rejected. Result: a per-job runtime error inside the worker.

The unit suite (`packages/bullmq/tests/bullmq-runtime.test.ts` "DB-first
execution" test) does NOT exercise this path because it uses
`InMemoryJobRepository`, which has no EntityManager. The 6/6 bullmq
test result and the 14/14 demo e2e result are both unchanged from
prior runs — neither test exercises the live BullMQ worker →
MikroORM repository path. This is why the new issue was hidden until
the live demo boot unblocked.

#### The fix (one-liner in the worker, NOT in the repository)

The cheapest correct fix is to wrap the `processJob` body in
`RequestContext.create(this.em, async () => { ... })` from
`@mikro-orm/core` (or `em.fork()` per call). Both options are
two-line changes in
`packages/bullmq/src/bullmq-runtime.service.ts:processJob`. The
fix is mechanical, well-scoped, and orthogonal to the Bug #2 fix
that just landed. It is **NOT** a regression of the prior plan; it
is a follow-up bug that the prior plan's "doc-only" attempt to fix
Bug #2 prevented anyone from seeing (because the worker never
reached its first repository call).

### 10.4 Live demo in BATCH_TRANSPORT=in-process — sanity check

The in-process path was not affected by the Bug #2 fix. Confirmed it
still works:

```
$ curl -X POST http://localhost:3000/jobs/import-products \
    -H "Content-Type: application/json" \
    -d '{"file":"sample-data/products-valid.csv"}'
{"executionId":"838e60e3-da38-4841-9309-a04c6da33b49","status":"COMPLETED"}
HTTP_STATUS=200

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT status, exit_code FROM batch_job_execution ORDER BY start_time DESC LIMIT 1"
  status   | exit_code
-----------+-----------
 COMPLETED | COMPLETED

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT step_name, status, exit_code, read_count, write_count, skip_count FROM batch_step_execution ORDER BY id DESC LIMIT 2"
    step_name    |  status   | exit_code | read_count | write_count | skip_count
-----------------+-----------+-----------+------------+-------------+------------
 import-products | COMPLETED | COMPLETED |          3 |           3 |          0
 validate-csv    | COMPLETED | COMPLETED |          0 |           0 |          0

$ PGPASSWORD=demo psql -h 127.0.0.1 -p 5434 -U demo -d nest_batch_demo -c \
    "SELECT COUNT(*) AS product_count FROM product"
 product_count
---------------
             3
```

Raw evidence: `.omo/evidence/task-2-inprocess.log`, `.omo/evidence/task-2-inprocess-db-state.log`.

### 10.5 Test suite re-run

All test suites that were green in the prior rerun are still green:

| Suite | Result | Evidence |
|-------|--------|----------|
| `pnpm --filter @nest-batch/core test` | 537/537 pass in 1.61s | `.omo/evidence/task-2-core-test.log` |
| `pnpm --filter @nest-batch/bullmq test` | 6/6 pass in 3.75s | `.omo/evidence/task-2-bullmq-test.log` |
| `pnpm --filter @nest-batch/demo test` | 19/19 pass in 565ms | `.omo/evidence/task-2-demo-test.log` |
| `pnpm --filter @nest-batch/demo test:e2e` | 14/14 pass in 3.18s | `.omo/evidence/task-2-demo-e2e.log` |
| `pnpm --filter @nest-batch/demo test:e2e:bullmq` | 3/3 FAIL (same MikroORM context error as §10.3) | `.omo/evidence/task-2-bullmq-e2e.log` |

The `test:e2e:bullmq` suite is the only one that exercises the live
BullMQ worker → MikroORM repository path, and it fails for the same
reason as the live demo. The prior F3 rerun also reported this
suite as failing; the only difference now is that the failure mode
has changed from "worker crashed during startup" (Bug #2) to
"worker started, dequeued, and then failed on the first repository
call" (new MikroORM context issue).

### 10.6 Comparison with prior F3 rerun

| Prior F3 status | Status after `nest-batch-bug2-fix` |
|------------------|-----------------------------------|
| Bullmq live demo: `UnknownDependenciesException` at startup | **FIXED** — boot reaches `Nest application successfully started`; `POST /jobs/import-products` returns 200 with `status=STARTING` |
| Bullmq live demo: no execution row in DB | **FIXED** — `batch_job_execution` row created in `STARTING` status |
| Bullmq live demo: no products written | **STILL BROKEN** — products = 0; new `cannotUseGlobalContext` error from `MikroORMJobRepository` in the worker callback |
| `test:e2e:bullmq` Scenario 1: `waitFor: timed out after 15000ms` (because the worker crashed at startup) | **STILL FAILS** with the same `waitFor: timed out` symptom, but root cause is now the MikroORM context error in the worker |
| All four non-bullmq test suites | **UNCHANGED — 537/537 + 6/6 + 19/19 + 14/14** |

### 10.7 FOLLOW-UP REQUIRED

**Bug #2 is RESOLVED** at the boot/DI level. The new issue uncovered
during this re-run is:

> **New bug (HIGH, not in scope of `nest-batch-bug2-fix`):** The BullMQ
> worker's `processJob` callback runs outside any `RequestContext`. The
> injected `MikroORMJobRepository` calls `this.em.findOne(...)` against
> the global `EntityManager`, which MikroORM 6 rejects with
> `ValidationError: Using global EntityManager instance methods for
> context specific actions is disallowed`.

**One-liner fix:** wrap the `processJob` body in
`RequestContext.create(this.em, async () => { ... })` (or
`em.fork()` per call) inside
`packages/bullmq/src/bullmq-runtime.service.ts`. With this in place:

- The bullmq live demo would reach `batch_job_execution.exit_code = 'COMPLETED'`
  and `batch_step_execution.write_count = 3`, matching the original
  F3 DoD #6 statement in full.
- `pnpm --filter @nest-batch/demo test:e2e:bullmq` Scenario 1
  (and the dependency-on-it Scenarios 2 + 3) would go green.

**Recommendation:** open a new plan `nest-batch-bug3-fix` (or
`nest-batch-microfollowup`) with this single task. Estimated effort:
small (1-2 tasks: 1 test, 1 worker wrap). Should be a follow-up
**after** this F3 rerun lands; do NOT add the fix to the current
verification — this is verification only, per the task contract.
