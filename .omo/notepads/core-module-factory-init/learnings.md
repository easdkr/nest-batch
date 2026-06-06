# Core Module Factory Init — Inherited Wisdom

## Architecture Overview
- @nest-batch/core exposes NestBatchModule (dynamic Nest module)
- Sibling packages: @nest-batch/mikro-orm, @nest-batch/typeorm, @nest-batch/bullmq
- Demo app at apps/demo/src/app.module.ts currently 333 lines with buildAppModuleBody() branching on transport

## Current API Surface

### NestBatchModule.forRoot(options) — TO BE REPLACED
- Options: repository?, transactionManager?, executionStrategy?, extraProviders?, explorer?
- Internally uses splitOptions() + buildProviders() + extractToken() helpers (lines 178, 240, 271)
- Exposes BATCH_OPTIONS (legacy string) + MODULE_OPTIONS_TOKEN (symbol)
- Exports: JobRegistry, DefinitionCompiler, BatchExplorer, FlowEvaluator, BatchScheduleRegistry, MODULE_OPTIONS_TOKEN, BATCH_SCHEDULE_REGISTRY

### BullmqBatchModule.forRoot({ connection, autoStartWorker? }) + forRootAsync()
- Currently at packages/bullmq/src/bullmq-batch.module.ts (244 lines)
- Binds EXECUTION_STRATEGY to BullMqExecutionStrategy via useExisting
- Has BULLMQ_MODULE_OPTIONS value provider
- Plan: Replace with BullmqAdapter.forRoot() / BullmqAdapter.forRootAsync()

### NestBatchMikroOrmModule.forRoot({ ...mikroOrmOptions, entities? })
- Currently at packages/mikro-orm/src/nest-batch-mikro-orm.module.ts (87 lines)
- Calls MikroOrmModule.forRoot(merged) internally
- Plan: Replace with MikroOrmAdapter.forRoot()

### @nest-batch/typeorm
- NO NestBatchTypeOrmModule exists (despite README mentioning it)
- Exports: TypeOrmJobRepository, TypeOrmTransactionManager, batchMetaEntities, CreateBatchMeta1700000000000
- Plan: T7 says "if needed"

## Key Tokens
- JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN, EXECUTION_STRATEGY, MODULE_OPTIONS_TOKEN, BATCH_SCHEDULE_REGISTRY

## Executor Subgraph (must auto-register)
- JobExecutor, ChunkStepExecutor, TaskletStepExecutor, ListenerInvoker, FlowEvaluator

## Critical Constraints (Must NOT Have)
- NO backward compat with old repository/transactionManager/executionStrategy/extraProviders options
- NO manual extraProviders registration by consumer
- NO transport mode branching in consumer code

---

## T1 (BatchAdapter interface) — Key Decisions

### New types added in `packages/core/src/module/adapter.ts`
- `BatchAdapter` interface: `{ readonly name: string; readonly module: DynamicModule; readonly globalProviders?: readonly Provider[] }`
  - Closed shape (no index signature) — every adapter is a deliberate implementation of one of the two known roles.
  - `globalProviders` is a `readonly Provider[]` (not mutable `Provider[]`) so adapters cannot mutate it after construction.
- `BatchAdaptersConfig` type: `{ readonly persistence: BatchAdapter; readonly transport: BatchAdapter }`
  - Both keys required. Closed shape (no `[key: string]` extension). The compiler will reject a missing adapter at the call site.
- JSDoc on both types documents: how core will use `module` (forward to `imports`) and `globalProviders` (register + re-export), with `@example` snippets for each adapter role.

### `NestBatchModuleOptions` rewritten
- Now: `{ readonly adapters: BatchAdaptersConfig }`.
- Removed: `AdapterProvider` type alias, `NestBatchModuleAsyncOptions` shape (T2 will redefine), `splitOptions` / `extractToken` / `buildProviders` helpers, `LEGACY_BATCH_OPTIONS_TOKEN` legacy alias.
- `BatchBootstrapper` is kept — its constructor takes `BatchExplorer` / `DefinitionCompiler` / `JobRegistry` / `BatchScheduleRegistry` (no options-shaped deps), and T3 will auto-register executors around it.

### `forRoot` / `forRootAsync` are minimal stubs
- Both return `{ module: NestBatchModule, global: true }` with no providers, no imports, no exports.
- `forRoot(_options: NestBatchModuleOptions)` requires the new shape — T2 will fill in the adapter-importing body.
- `forRootAsync(_options: NestBatchModuleAsyncOptions)` — the type is a placeholder that exists only to keep the file compiling; T2 will rewrite both the type and the body.
- The class docstring carries a `TODO(core-factory-init/T2):` marker pointing to the real work.

### Re-exports
- `InProcessExecutionStrategy` and `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER` stay (T4 will use them when wiring `InProcessAdapter`).
- `BatchBootstrapper` stays (T3 will use it to auto-register the executor subgraph).
- `JobExecutor` and other executor class exports stay (T3 will auto-register).
- `MODULE_OPTIONS_TOKEN`, `JOB_REPOSITORY_TOKEN`, `TRANSACTION_MANAGER_TOKEN`, `BATCH_SCHEDULE_REGISTRY`, `EXECUTION_STRATEGY` all stay — they are the stable DI tokens sibling packages bind to.
- `LEGACY_BATCH_OPTIONS_TOKEN` removed from `tokens.ts` (and the `'BATCH_OPTIONS'` value provider no longer registered in `forRoot`).
- `BatchScheduleRegistry` and its `BatchScheduleEntry` export stay — the bootstrapper still reads/writes it.

### `adapter-options.ts` is intentionally untouched in T1
- The `AdapterOptions` interface (`[key: string]: unknown`) is now orphan code — nothing in core extends it anymore. T2/T9 may remove it. Leaving it for T1 keeps the diff minimal and avoids breaking the test files in `tests/module/module-tokens.spec.ts` further than the contract change already does.

### Typecheck evidence
- `pnpm --filter @nest-batch/core build` passes (source compiles, including `tsc --emitDeclarationOnly` with the build tsconfig that excludes tests).
- `pnpm --filter @nest-batch/core typecheck` (`tsc --noEmit` with the default tsconfig that includes tests) fails — **all** errors are in `tests/e2e/library-smoke.test.ts`, `tests/execution/listener-invocation.test.ts`, `tests/module/{nest-batch.module.spec,module-tokens.spec}.ts`, and `tests/scheduling/batch-scheduled-inert.test.ts` because they use the removed `forRoot()` / `forRoot({ explorer: true })` / `forRoot({ repository: ... })` / `forRootAsync({ useFactory: () => ({ explorer: true }) })` shapes. T9 owns the test-file rewrite. The src/ tree typechecks cleanly (see `.omo/evidence/task-1-typecheck-src-only.txt`).
- T2 must keep this in mind: the new `forRoot` signature does not allow `forRoot()` with no args (the contract requires `adapters`). The test file calls in T9 will need to pass a `BatchAdaptersConfig` (or a stub `BatchAdapter` literal).

### Boundary test
- No new imports of `bullmq` / `mikro-orm` / `typeorm` / `drizzle-orm` / `cron` were introduced. The new `adapter.ts` only imports from `@nestjs/common` (`DynamicModule`, `Provider`). The boundary test will keep passing.

---

## T4: InProcessAdapter factory — Key Decisions

### Shape chosen
- `InProcessAdapter.forRoot(): BatchAdapter` (no options)
- Returns `{ name: 'in-process', module: <DynamicModule> }` with `globalProviders` omitted (they live in the module's own `exports` list)
- Static method (no `forRootAsync` — the in-process transport has no async config to resolve)
- `InProcessModule` is an empty class with `@Module({})` — minimum possible surface, no lifecycle hooks

### Module structure
- `module: InProcessModule` (empty class)
- `global: true` (mirrors `NestBatchModule` so the strategy is visible to `JobLauncher` at the app level)
- `providers: [InProcessExecutionStrategy, IN_PROCESS_EXECUTION_STRATEGY_PROVIDER]`
- `exports: [InProcessExecutionStrategy, IN_PROCESS_EXECUTION_STRATEGY_PROVIDER, EXECUTION_STRATEGY]`
  - Exporting the `EXECUTION_STRATEGY` token (not just the strategy class) lets `moduleRef.get(EXECUTION_STRATEGY)` resolve in `/healthz`-style checks

### Why `globalProviders` is omitted (not `[]`, not present)
- The `BatchAdapter` interface allows `globalProviders` for runtime classes the adapter's own module needs but the host should also see
- The recommended path is to put them in the adapter's own `DynamicModule.exports` (which is what T4 does) — T1's JSDoc on `globalProviders` reads "Use this for runtime classes the adapter's own module needs to inject but that the host app should also be able to inject"
- `JobLauncher` (registered by `NestBatchModule`, not by this adapter) injects the strategy via the `EXECUTION_STRATEGY` token, which is already exported from this module, so the runtime resolution chain works without core having to know which adapter is active

### Why the adapter lives in core (not in a sibling package)
- "In-process" is the zero-dep default transport; if it were a sibling package, `apps` would have to install a package just to get the default behaviour
- It is the cheapest possible deployment option — zero infrastructure, zero peer deps
- Mirrors the pattern of NestJS's own `ScheduleModule` / `CacheModule`: the default modes ship in the core package, the queue-backed modes live in siblings

### Why static `forRoot()` and no `forRootAsync`
- The in-process transport has no connection params, no credentials, no factory-time work
- A `useFactory` would have nothing to inject, so `forRootAsync` would be a meaningless overload
- If a future consumer needs to plumb "config" into the in-process transport, they almost certainly want a real transport adapter (e.g. BullMQ with a config service) instead

### Typecheck status
- `pnpm --filter @nest-batch/core typecheck` reports errors, all in `tests/**` (pre-existing T1/T2 breaking change, migration is T9-T12 work, explicitly out of scope for T4)
- `npx tsc --noEmit -p tsconfig.build.json` (the build config) → 0 errors
- `pnpm --filter @nest-batch/core build` → 80 files compiled, 0 errors
- `npx tsc --noEmit` on the new file in isolation → 0 errors

### Pre-existing test errors
- `tests/module/nest-batch.module.spec.ts`, `tests/module/module-tokens.spec.ts`, `tests/e2e/library-smoke.test.ts`, `tests/execution/listener-invocation.test.ts`, `tests/scheduling/batch-scheduled-inert.test.ts`
- All fail because they call `NestBatchModule.forRoot()` with no args, or pass `explorer` / `extraProviders` / `repository` / `transactionManager` / `executionStrategy` fields that the new T1/T2 shape rejects
- These will be fixed by T9-T12 (test migration to the new API)


---

## T3 REGRESSION — IMPORTANT

T3 was committed first (commit 298484a) with the executor subgraph added to `buildProviders()` and the exports. However, T1 was committed AFTER T3 (commit 3026790) and **rewrote the entire `nest-batch.module.ts` file** to a stub form. T1's rewrite overwrote T3's additions.

### Current state of T3's work
- T3's 4 executor classes (`JobExecutor`, `ChunkStepExecutor`, `TaskletStepExecutor`, `ListenerInvoker`) are NOT currently registered in the module
- T3's exports additions are GONE
- T1's stub `forRoot` returns just `{ module: NestBatchModule, global: true }` with no providers, no imports, no exports

### Resolution
- T2 (which rewrites `forRoot` / `forRootAsync`) MUST include the executor subgraph registration
- T2's prompt will be updated to combine the T2 refactor + T3's auto-register executor requirement
- T3's plan checkbox will remain UNCHECKED until T2 is verified

### Why this happened
Parallel T1 + T3 both targeted the same file. T1's instruction was to "rewrite nest-batch.module.ts" (stripping old code, replacing with stubs). T3's instruction was to add 4 classes to the existing `buildProviders()`. When T1 landed after T3, it overwrote T3's additions. 

### Lesson for next batches
When two parallel tasks target the same file with edits, one should use a "create new file" or "additive only" approach, OR they should be explicitly ordered. For T2/T3 coordination: T2 must be a single rewrite that includes T3's requirements.

---

## T6: BullmqAdapter factory — Key Decisions

### Shape chosen
- `BullmqAdapter.forRoot(options)` (sync) + `BullmqAdapter.forRootAsync({ imports, inject, useFactory })` (async), both returning `BatchAdapter` from `@nest-batch/core`.
- Static methods, no constructor (mirrors `InProcessAdapter.forRoot()`).
- `BullmqModule` is an empty `@Module({})` class — minimum possible surface, no lifecycle hooks, no metadata.

### Module structure (DynamicModule payload)
- `module: BullmqModule` (the empty class)
- `global: true` (mirrors `NestBatchModule` so `EXECUTION_STRATEGY` is visible to `JobLauncher` at the app level)
- `providers`:
  - `BullMqExecutionStrategy` (class)
  - `BullmqRuntimeService` (class)
  - `BullmqScheduleService` (class)
  - `{ provide: EXECUTION_STRATEGY, useExisting: BullMqExecutionStrategy }` (the strategy token alias)
  - `{ provide: BULLMQ_MODULE_OPTIONS, useValue: <resolved> }` (sync path) OR
    `{ provide: BULLMQ_MODULE_OPTIONS, useFactory: (fromFactory) => frozen(fromFactory), inject: [OPTIONS_FACTORY] }` (async path)
  - async path also adds `{ provide: OPTIONS_FACTORY, useFactory: <user factory>, inject: [...user inject] }` sentinel
- `exports`: `EXECUTION_STRATEGY`, `BULLMQ_MODULE_OPTIONS`, `BullMqExecutionStrategy`, `BullmqRuntimeService`, `BullmqScheduleService` — centralised in `ADAPTER_EXPORTS` const, shared by both paths.

### Async path uses the same sentinel pattern as the legacy `BullmqBatchModule.forRootAsync`
- `OPTIONS_FACTORY = Symbol.for('@nest-batch/bullmq/OPTIONS_FACTORY')` — the user's `useFactory` runs under this token.
- `BULLMQ_MODULE_OPTIONS` depends on `OPTIONS_FACTORY` and freezes the result.
- The static `BULLMQ_MODULE_OPTIONS` value provider (from `buildStaticProviders`) is filtered out before the async factory pair is spliced in — duplicate `provide` would crash Nest's container.

### `buildStaticProviders` + `buildBullmqDynamicModule` helpers
- `buildStaticProviders(resolved)` returns the canonical 5-provider list (3 classes + 2 useExisting/useValue). Sync path uses it as-is; async path filters the `BULLMQ_MODULE_OPTIONS` value provider out and prepends the factory pair.
- `buildBullmqDynamicModule({ providers, imports? })` constructs the `DynamicModule` payload with `global: true`, the shared `ADAPTER_EXPORTS`, and an optional `imports` array (only set for async — sync doesn't need any).
- Centralising the provider list + exports list in two helpers means a future addition (e.g. a per-role client builder) only needs to be touched in one place each.

### `globalProviders` intentionally omitted
- Same reasoning as T4's `InProcessAdapter`: `JobLauncher` injects the strategy via the `EXECUTION_STRATEGY` token, which is already in the module's own `exports`. The runtime resolution chain works without core having to know which adapter is active.
- The `BatchAdapter` interface's `globalProviders` field is `readonly Provider[]` (optional), so omitting it is a valid shape.

### `forRootAsync` exports fix (vs. the legacy class)
- The legacy `BullmqBatchModule.forRootAsync` exports list was missing `BullmqRuntimeService` — almost certainly an oversight. The new `ADAPTER_EXPORTS` const has all 5 entries, and both `forRoot` and `forRootAsync` go through the same `buildBullmqDynamicModule` helper, so both paths now export the same set.

### Legacy file deleted
- `packages/bullmq/src/bullmq-batch.module.ts` was DELETED. The plan said "Do NOT keep old module class as primary export" so the legacy class is gone. The package barrel's `export * from './bullmq-batch.module'` was replaced with `export * from './adapters'`.
- Tests (`tests/bullmq-e2e.config.ts:309`, `tests/bullmq-runtime.test.ts`) still reference `bullmqAdapter.BullmqBatchModule.forRoot(...)`. These will fail to import until T11 migrates them — but the bullmq package's `tsconfig.json` `include` is `["src/**/*"]` (tests are excluded), so `pnpm typecheck` and `pnpm build` both pass cleanly. T11 owns the test migration.

### Pre-existing breakage fixed
- The legacy `bullmq-batch.module.ts` imported `AdapterProvider` from `@nest-batch/core` — T1 removed that type. The import was dead code (just a JSDoc re-export at the bottom of the file) and the typecheck was already broken on T6's start state:
  - Baseline: `error TS2305: Module '"@nest-batch/core"' has no exported member 'AdapterProvider'.`
  - After T6: clean.
- The fix is incidental — the new `bullmq.adapter.ts` does not import `AdapterProvider` at all.

### Typecheck status
- `pnpm --filter @nest-batch/bullmq typecheck` → 0 errors (src-only, tests excluded by tsconfig include).
- `pnpm --filter @nest-batch/bullmq build` → "Successfully compiled: 8 files with swc" (5 unchanged src files + new `adapters/bullmq.adapter.ts` + new `adapters/index.ts` = 7 source files + 1 emitted declaration file = 8 total swc entries). `tsc --emitDeclarationOnly` also passes (no output, exit 0).

### Boundary test status
- No new imports of `bullmq` / `mikro-orm` / `typeorm` / `drizzle-orm` / `cron` in core (T6 doesn't touch core). The new `bullmq.adapter.ts` only imports from `@nestjs/common` (`Module`, `DynamicModule`, `Provider`) and `@nest-batch/core` (`EXECUTION_STRATEGY`, `BatchAdapter`). The core boundary test will keep passing.
