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

## T7: TypeOrmAdapter factory — Key Decisions

### Decision: adapter created
- The `@nest-batch/typeorm` package had **no module file at all** before T7. The README claims a `NestBatchTypeOrmModule` exists but the code only has `repository/`, `transaction/`, `entities/`, and `migrations/` subdirs.
- Both `TypeOrmJobRepository` and `TypeOrmTransactionManager` were already exported and complete. The adapter is purely the factory-pattern wiring.
- `@nestjs/typeorm` ^10 || ^11 is already a peer dep — `TypeOrmModule.forRoot()` is the natural internal call.

### Files added
- `packages/typeorm/src/adapters/typeorm.adapter.ts` — the `TypeOrmAdapter` class with static `forRoot(options: TypeOrmAdapterOptions): BatchAdapter`.
- `packages/typeorm/src/adapters/index.ts` — barrel re-exporting `./typeorm.adapter`.
- `packages/typeorm/src/index.ts` — one new line: `export * from './adapters';`.

### Shape
- `forRoot(options: TypeOrmAdapterOptions): BatchAdapter`
- `TypeOrmAdapterOptions = Omit<TypeOrmModuleOptions, 'entities'> & { readonly entities?: readonly EntityTarget<unknown>[] }`
- Returns `{ name: 'typeorm', module: <DynamicModule>, globalProviders: [...] }`
- The module:
  - imports `TypeOrmModule.forRoot(merged)` where `merged` is the host's options + `BATCH_META_ENTITIES` spread
  - provides the two impl classes + the two token bindings
  - exports the classes + the tokens
  - is NOT `global: true` (relying on `globalProviders` for host visibility — same T1 rationale as InProcessAdapter's `global: true` decision was for a different reason)
- `globalProviders` lists the two token bindings: `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN` (the canonical symbol tokens from `@nest-batch/core`).

### Reference pattern
- T5 (MikroOrmAdapter) has NOT landed at the time T7 ran — no `packages/mikro-orm/src/adapters/mikro-orm.adapter.ts` file exists. T7 used `InProcessAdapter` (in `packages/core/src/adapters/in-process.adapter.ts`) as the primary pattern reference and the existing `NestBatchMikroOrmModule.forRoot` (in `packages/mikro-orm/src/nest-batch-mikro-orm.module.ts`) as the secondary reference for the entity-merging shape.
- UPDATE: T5 landed as commit `68140a0` between when T7 was scheduled and when T7 actually ran. T7 was re-aligned to match T5 exactly so the two adapter files are in lockstep:
  - `BATCH_META_ENTITIES` const tuple (not the `batchMetaEntities()` function) for entity merging
  - Dedicated empty `@Module({})` carrier class (`TypeOrmBatchModule`) — cannot reuse the imported `TypeOrmModule` because it has its own `forRoot()` factory and a second config for the same class would collide
  - `global: true` on the wrapping module (mirrors `NestBatchModule`, `InProcessAdapter`, `MikroOrmAdapter`)
  - `useExisting` in the module's own `providers` so the symbol tokens and the concrete class share a single instance
  - `useClass` in `globalProviders` so the core engine can construct the binding independently if the host's `AppModule` resolves it directly
  - Token-only `exports` (the concrete classes are reachable via the `useExisting` chain)
- When T5 picks a different shape, T7 may need a follow-up refactor.

### Design choices
1. **Static `forRoot`, no `forRootAsync`.** Same as InProcessAdapter. Consumers needing async config can wrap `TypeOrmModule.forRootAsync({...})` in a thin custom factory. Adding a parallel `forRootAsync` on top would be a re-skinned `useFactory` and would obscure the host's actual async source.
2. **Self-contained, no BYO DataSource.** The previous README described a "BYO DataSource" shape; deliberately not exposed through this factory because `@nestjs/typeorm` does not support two `forRoot()` calls in the same app. The README example showing `dataSource: /* your DataSource */` is now stale — the new factory is the source of truth.
3. **Module IS `global: true`** (after T5 alignment, was originally going to skip it). Mirrors `NestBatchModule`, `InProcessAdapter`, and `MikroOrmAdapter`. The `globalProviders` field is still populated, but the module itself is also marked global so `@Inject` from sibling sub-modules works without forcing the host to re-import this module everywhere.
4. **Use `BATCH_META_ENTITIES` const, not the `batchMetaEntities()` function.** The const tuple has a clean `Function` element type that matches TypeORM's `MixedList<string | Function | EntitySchema<any>>` without a cast. The function form returns `EntityTarget<unknown>[]` which is too broad (includes the `{ name; type }` object form, not a valid `MixedList` element).
5. **One cast at the merge boundary.** The spread `{...options, entities}` loses the discriminated-union narrowing on `type` (postgres vs mysql vs ...); the final result is cast to `TypeOrmModuleOptions` to restore the contract. Safe because the host's options were already typed as `Omit<TypeOrmModuleOptions, 'entities'>`.
6. **`useExisting` in module providers, `useClass` in globalProviders** (after T5 alignment). `useExisting` chains the symbol token to the concrete class instance within the adapter's own module (no duplicate instances). `useClass` in `globalProviders` lets the core engine construct the binding independently if it needs to inject the token without going through the adapter's module.

### Typecheck/build status
- `pnpm --filter @nest-batch/typeorm typecheck` → 0 errors (see `.omo/evidence/task-7-typeorm-typecheck.log`).
- `pnpm --filter @nest-batch/typeorm build` → 8 files compiled (was 6), 0 errors (see `.omo/evidence/task-7-typeorm-build.log`).
- `dist/src/adapters/typeorm.adapter.{js,d.ts}` and `dist/src/adapters/index.{js,d.ts}` are present in the build output.

### T5 coordination note
- T7 deliberately mirrors the `InProcessAdapter` shape (a class with a static `forRoot()` method), not the `as const satisfies BatchAdapter` literal-object form shown in the T1 JSDoc example. The reason: `InProcessAdapter` (T4) is the only T1–T7 task to have landed at the time of T7, so it's the only empirically proven shape. If T5 picks the literal-object form, T7 should be reviewed for shape parity but the contract is the same.
- The `name` field is the string literal `'typeorm'` (not `as const`) because the class doesn't support literal narrowing without a const assertion. If the compiler complains in T2's adapter-validation code, T7 may need to switch to `as const satisfies BatchAdapter` (and an explicit `readonly name: 'typeorm'`).
- **UPDATE after T5 landed (commit 68140a0):** T5 uses the same class-with-static-forRoot shape as InProcessAdapter and T7, so the class-vs-literal decision is settled — all three adapter factories (InProcess, MikroOrm, TypeOrm) use the class form. T5 also uses the same `useClass` shape in `globalProviders`, confirming T2 should accept this pattern. T7 has been re-aligned to T5's exact `useExisting` + token-only-exports shape.


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


---

## T5: MikroOrmAdapter factory — Key Decisions

### Shape chosen
- `MikroOrmAdapter.forRoot(options: Omit<MikroOrmModuleOptions, 'entities'> & { entities?: MikroOrmModuleOptions['entities'] }): BatchAdapter` (sync only — no `forRootAsync` in this release; async can be added by T9/T10 if needed, mirroring the `BullmqAdapter.forRootAsync` sentinel pattern).
- Static method, no constructor (mirrors `InProcessAdapter.forRoot()`).
- `MikroOrmAdapterModule` is an empty `@Module({})` class — minimum possible surface, no lifecycle hooks, no metadata.

### Module structure (DynamicModule payload)
- `module: MikroOrmAdapterModule` (the empty class — NOT the imported `MikroOrmModule`).
- `global: true` (mirrors `NestBatchModule` so the `JobRepository` / `TransactionManager` tokens are visible to the core engine at the app level).
- `imports: [MikroOrmModule.forRoot(merged)]` — the `MikroOrmModule` from `@mikro-orm/nestjs`, called with `BATCH_META_ENTITIES` spread into `entities` next to the host's user-domain entities.
- `providers`:
  - `MikroORMJobRepository` (class) — DI-instantiable.
  - `MikroORMTransactionManager` (class) — DI-instantiable.
  - `{ provide: JOB_REPOSITORY_TOKEN, useExisting: MikroORMJobRepository }` — symbol alias.
  - `{ provide: TRANSACTION_MANAGER_TOKEN, useExisting: MikroORMTransactionManager }` — symbol alias.
- `exports`: `JOB_REPOSITORY_TOKEN`, `TRANSACTION_MANAGER_TOKEN` — both symbol tokens (not the classes) so other modules resolve by the canonical DI token.

### Why a dedicated `MikroOrmAdapterModule` class (not the imported `MikroOrmModule`)
- The task spec said `module: MikroOrmModule` in the prose, but using the imported `MikroOrmModule` from `@mikro-orm/nestjs` as the `module:` field would collide with the same class appearing in `imports` (via `MikroOrmModule.forRoot(merged)`). Nest would see two `DynamicModule` configs for the same class. The cleanest fix is a dedicated empty class — same pattern as `InProcessModule` (T4) and `BullmqModule` (T6).
- The dedicated class also makes the `BatchAdapter` self-describing: the host can read the `module.module` field and see that this is the adapter's own carrier, not a third-party module reference.
- The class is `@Module({})` — no static providers, no decorators beyond the empty module marker. All configuration lives in the `DynamicModule` literal returned by `forRoot()`.

### Why `globalProviders` is USED here (not omitted, unlike T4 and T6)
- T4's `InProcessAdapter` and T6's `BullmqAdapter` omit `globalProviders` because their strategy classes live in the adapter's own module and are exported by the symbol (`EXECUTION_STRATEGY`).
- T5's `MikroOrmAdapter` uses `globalProviders` because the `JobRepository` / `TransactionManager` bindings are needed by `@nest-batch/core`'s engine (`JobLauncher`, `JobExecutor`) — which is a *separate* module. Even though the wrapping module is `global: true` and exports the symbols, the `BatchAdapter.globalProviders` field is the explicit signal to `NestBatchModule` (T2) to register the bindings into core's own DI scope, so the engine can resolve them through core's own container.
- The shape is `{ provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository }` and `{ provide: TRANSACTION_MANAGER_TOKEN, useClass: MikroORMTransactionManager }` — the canonical symbol form (not the abstract class form the README uses). This matches the existing pattern in T4 (which uses `EXECUTION_STRATEGY` symbol) and the MUST DO clause of the T5 prompt.

### Why `useClass` in `globalProviders` (not `useExisting`)
- The adapter's own `DynamicModule.providers` uses `useExisting` to alias the symbol to the already-DI-managed class instance (one MikroORM connection, one repository instance, one transaction-manager instance).
- The adapter's `globalProviders` is the *list* core will register into its own DI scope. Core does not import this adapter's `DynamicModule.imports` (so it cannot reach `MikroORMJobRepository` through DI to alias it), and `useExisting` would resolve to `undefined` (no instance to alias). `useClass` lets Nest construct a fresh instance from the class's own injection metadata — the `EntityManager` from the `MikroOrmModule.forRoot(...)` registration — and that fresh instance is the same instance the adapter's own `useExisting` was pointing at. So both paths resolve to the same singleton, but the registration mechanism is different.

### Legacy file deleted, `BATCH_META_ENTITIES` re-homed
- `packages/mikro-orm/src/nest-batch-mikro-orm.module.ts` was DELETED. The plan said "Do NOT keep old module class as primary export" so the legacy class is gone.
- `BATCH_META_ENTITIES` (the typed tuple of the six batch meta entities) was moved to `packages/mikro-orm/src/entities/job-meta.entities.ts` — the natural home (it IS the list of those entities). The JSDoc was updated to mention the new `MikroOrmAdapter.forRoot()` factory.
- `packages/mikro-orm/src/mikro-orm.config.ts` (which imports `BATCH_META_ENTITIES` for the `createBatchMikroOrmConfig` helper) had its import path updated from `./nest-batch-mikro-orm.module` to `./entities/job-meta.entities`.
- The package barrel (`packages/mikro-orm/src/index.ts`) replaces the old `export * from './nest-batch-mikro-orm.module'` with `export * from './adapters'`. The header JSDoc was updated to document the new factory-pattern wiring (`NestBatchModule.forRoot({ adapters: { persistence: MikroOrmAdapter.forRoot({...}) } })`).
- Tests (`tests/contract.test.ts`, `tests/mikroorm-backend.test.ts`) do not import `NestBatchMikroOrmModule` or `BATCH_META_ENTITIES` — they use the entity classes and the concrete impl classes, which are still exported. T10 owns the test migration to the new factory API.

### Typecheck / build status
- `pnpm --filter @nest-batch/mikro-orm typecheck` → 0 errors (src-only, tests excluded by tsconfig include).
- `pnpm --filter @nest-batch/mikro-orm build` → "Successfully compiled: 11 files with swc" (5 unchanged src files + 2 new adapter files + 3 migration files + 1 emitted declaration file = 11 swc entries). `tsc --emitDeclarationOnly` also passes (exit 0).
- Clean dist verified: removed `dist/` and re-ran build — no stale `nest-batch-mikro-orm.module.{d.ts,js}` left over; new `dist/src/adapters/{mikro-orm.adapter,index}.{d.ts,js}` present.

### Boundary test status
- No new imports of `bullmq` / `mikro-orm` / `typeorm` / `drizzle-orm` / `cron` in core (T5 doesn't touch core). The new `mikro-orm.adapter.ts` only imports from `@nestjs/common` (`Module`, `DynamicModule`, `Provider`), `@mikro-orm/nestjs` (`MikroOrmModule`, `MikroOrmModuleOptions`), and `@nest-batch/core` (`JOB_REPOSITORY_TOKEN`, `TRANSACTION_MANAGER_TOKEN`, `BatchAdapter`). The core boundary test will keep passing.

---

## T2: NestBatchModule.forRoot / forRootAsync rewrite + T3 regression fix — Key Decisions

### T3 regression re-applied
- T3's executor subgraph (`JobExecutor`, `ChunkStepExecutor`, `TaskletStepExecutor`, `ListenerInvoker`) is now auto-registered by BOTH `forRoot` and `forRootAsync` in the core `providers` list, and exported alongside the core classes.
- This re-creates T3's intent inside the new factory-pattern architecture (T3 was overwritten by T1's stub rewrite; T2 is the unified rewrite that picks up the dropped work).

### Shape chosen
- `forRoot(options: NestBatchModuleOptions): DynamicModule` — takes `{ adapters: { persistence, transport } }` synchronously. Builds the full module: merges the two adapter `DynamicModule`s into `imports`, adds `DiscoveryModule` from `@nestjs/core`, registers the core classes + executor subgraph + the adapter's `globalProviders`, and binds the resolved `BatchAdaptersConfig` to `MODULE_OPTIONS_TOKEN` via a value provider.
- `forRootAsync(options: NestBatchModuleAsyncOptions): DynamicModule` — takes `{ imports?, inject?, useFactory }` returning `Promise<BatchAdaptersConfig> | BatchAdaptersConfig`. Uses the sentinel factory pattern (mirrors `BullmqBatchModule.forRootAsync` and T6's `BullmqAdapter.forRootAsync`): the user's `useFactory` is registered under `OPTIONS_FACTORY = Symbol.for('@nest-batch/core/OPTIONS_FACTORY')`, and `MODULE_OPTIONS_TOKEN` is bound to its resolved value via a follow-up `useFactory` provider.
- Both factories return `global: true` `DynamicModule`s. The class body is empty (`@Module({})`); all wiring happens in the static factory methods.

### Auto-registered providers (both paths)
- **Discovery-required** (T2's contract): `JobRegistry`, `DefinitionCompiler`, `BatchExplorer`, `FlowEvaluator`, `BatchScheduleRegistry`, `BatchBootstrapper`.
- **Executor subgraph** (T3's regression, re-applied): `JobExecutor`, `ChunkStepExecutor`, `TaskletStepExecutor`, `ListenerInvoker`.
- All ten are listed in both `providers` AND `exports` so the host (and any sibling package) can resolve them through the global module chain.

### forRootAsync caveat — async path does NOT auto-merge adapter globalProviders
- NestJS cannot dynamically import a `DynamicModule` at module-build time, so the async path does NOT auto-merge the adapter modules' `globalProviders` into the core module's `providers` list the way `forRoot` does. Documented in the `NestBatchModuleAsyncOptions` JSDoc.
- Two consequences for callers of `forRootAsync`:
  1. The adapter `DynamicModule`s must be passed in the caller's `imports` array (e.g. `imports: [MikroOrmAdapter.module, InProcessAdapter.module]`) so Nest sees them in the module graph.
  2. The factory's return value is used only for the `MODULE_OPTIONS_TOKEN` binding (adapters introspection); sibling packages and the host can read the resolved config via `@Inject(MODULE_OPTIONS_TOKEN)`.
- For the full auto-merge (adapter modules + `globalProviders` registered into core's own DI scope), prefer `forRoot` with a pre-resolved `BatchAdaptersConfig`. The async path is for adapters whose factory needs to consult a config service to decide which adapter to plug in.
- The "Both" clause in the T2 prompt's EXPECTED OUTCOME is interpreted as "both expose the same provider/exports API surface", not "both do identical static module merging". This matches how every NestJS `ConfigurableModuleBuilder` / `forRootAsync` pattern in the wild works.

### Sentinel factory plumbing
- `OPTIONS_FACTORY = Symbol.for('@nest-batch/core/OPTIONS_FACTORY')` — matches the `Symbol.for(...)` convention used by `BATCH_SCHEDULE_REGISTRY`, `MODULE_OPTIONS_TOKEN`, `JOB_REPOSITORY_TOKEN`, etc. in `./tokens.ts`. Stable across module boundaries; tooling or sibling packages that know the description string can resolve the same symbol.
- `factoryProvider: { provide: OPTIONS_FACTORY, useFactory: <user factory>, inject: [...user inject] }` — the user's factory runs under DI, can pull from `ConfigService` or any other injectable.
- `optionsProvider: { provide: MODULE_OPTIONS_TOKEN, useFactory: (fromFactory) => fromFactory, inject: [OPTIONS_FACTORY] }` — bridges the sentinel to the canonical token.
- `inject` is typed as `readonly unknown[]` (matching the Bullmq reference) and narrowed to `Array<string | symbol | Function>` when fed to the provider, which is the broadest type Nest's `useFactory.inject` accepts.

### What the T2 prompt listed as MUST NOT DO — all honoured
- **No `InProcessExecutionStrategy` registration in core.** The T4 `InProcessAdapter`'s own `DynamicModule.providers` and `DynamicModule.exports` handle the strategy + `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER` binding. Core only re-exports the two symbols (T4) so host code can wire them up by hand if needed.
- **No backward-compat shims.** No `LEGACY_BATCH_OPTIONS_TOKEN`, no `splitOptions` / `extractToken` / `buildProviders` helpers, no `AdapterProvider` type. T1 already removed them; T2 doesn't re-introduce them.
- **No new dependencies.** Only added `DiscoveryModule` import from `@nestjs/core` (already a peer dep).

### `BatchBootstrapper` class preserved verbatim
- The `BatchBootstrapper` class (its constructor + `onApplicationBootstrap` body + the `allMethodNames` prototype walker) was kept unchanged from the T1 stub. Its constructor signature is `(BatchExplorer, DefinitionCompiler, JobRegistry, BatchScheduleRegistry)` — all four are auto-registered in the new `providers` list, so the DI graph resolves the bootstrapper without changes.
- The `@Injectable()` decorator is preserved; the class is registered as a provider AND exported so the host can inject it (e.g. to test the bootstrapper's behaviour in isolation).

### `InProcessExecutionStrategy` re-exports preserved
- The re-export line `export { InProcessExecutionStrategy, IN_PROCESS_EXECUTION_STRATEGY_PROVIDER };` is kept verbatim from T1. The JSDoc block above it was updated to reflect the new `forRoot({ adapters: { transport: InProcessAdapter } })` shape (the old JSDoc referenced the host-app `providers` array pattern, which is no longer the recommended wiring).

### Imports cleaned up per T2 prompt's MUST NOT clause
- No `LEGACY_BATCH_OPTIONS_TOKEN` import (the symbol was deleted by T1).
- No `splitOptions` / `extractToken` / `buildProviders` helpers (all removed by T1's stub rewrite; T2 doesn't re-introduce them).
- No `AdapterProvider` import / type alias (removed by T1).

### Imports added (per T2 prompt's MUST DO clause)
- `DiscoveryModule` from `@nestjs/core` — required for `BatchExplorer` to work; was removed by T1.
- `JobExecutor` from `../execution/job-executor` — was removed by T1; T3's regression.
- `ChunkStepExecutor` from `../execution/chunk-step-executor` — was removed by T1; T3's regression.
- `TaskletStepExecutor` from `../execution/tasklet-step-executor` — was removed by T1; T3's regression.
- `ListenerInvoker` from `../execution/listener-invoker` — was removed by T1; T3's regression.
- `FlowEvaluator` from `../flow/flow-evaluator` — was removed by T1.
- `BATCH_SCHEDULE_REGISTRY` from `./tokens` — re-added to the module's `exports` alongside the `BatchScheduleRegistry` class (per the EXPECTED OUTCOME clause "Re-add the `BATCH_SCHEDULE_REGISTRY` token to the module's exports").
- `MODULE_OPTIONS_TOKEN` from `./tokens` — was already in T1's stub via tokens re-export; T2 binds it via value provider (sync) or follow-up `useFactory` (async).
- `Provider` type from `@nestjs/common` — used for the explicit `Provider` annotations on the sentinel factories.

### `BATCH_SCHEDULE_REGISTRY` token export
- The token was in the T1 exports list (re-exported from `./tokens`) but T1's stub `forRoot` had no `exports` array at all. T2's `forRoot` and `forRootAsync` both add `BATCH_SCHEDULE_REGISTRY` to the `exports` array alongside the `BatchScheduleRegistry` class — matches the T2 prompt's EXPECTED OUTCOME.

### Why no module-level `CORE_PROVIDERS` / `EXECUTOR_PROVIDERS` constants
- The two arrays reference `BatchBootstrapper`, which is a class declared mid-file. Hoisting in ES classes is binding-only (TDZ for the value), so a module-level `const` array referencing the class would throw `ReferenceError: Cannot access 'BatchBootstrapper' before initialization` when the file is loaded.
- Inlining the provider lists inside `forRoot` and `forRootAsync` (with the same items in both) keeps the two paths in lockstep without the TDZ pitfall. The arrays are short (10 items) and inlined so the duplication is cheap to read.
- Same reasoning applies to `EXECUTOR_PROVIDERS` — though it only references classes from sibling files (no in-file class deps), keeping the two lists inline avoids the indirection and makes the diff against T1's stub clearer.

### Evidence
- `.omo/evidence/task-2-typecheck.txt` — `pnpm --filter @nest-batch/core typecheck` output. All errors are in `tests/**` (pre-existing T1 breaking change: tests call `forRoot()` with no args, or pass `explorer` / `extraProviders` / `repository` / `transactionManager` / `executionStrategy` fields that T1's stub removed). T9-T12 own the test migration. `src/**` typechecks cleanly (zero errors in `src/`).
- `.omo/evidence/task-2-build.txt` — `pnpm --filter @nest-batch/core build` output. "Successfully compiled: 80 files with swc" (the `tsconfig.build.json` excludes tests). `tsc --emitDeclarationOnly` also passes (no output, exit 0).

### T2 / T3 status
- T2 + T3 combined into a single commit: `feat(core): refactor forRoot/forRootAsync with adapter pattern + auto-register executor subgraph`
- T3's plan checkbox can now be ticked — the regression is resolved.
- T1's `forRoot` / `forRootAsync` stub bodies are replaced with real implementations. T1's interface work (`BatchAdapter` / `BatchAdaptersConfig` in `adapter.ts`) and the InProcessAdapter (T4) / BullmqAdapter (T6) / MikroOrmAdapter (T5) all plug into the new factory body without further changes.
