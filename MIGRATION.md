# Migration notes

This document covers the breaking changes between the previous
single-package `@nest-batch/nest-batch` layout and the current
`@nest-batch/*` package family. It is a moving target: the most
recent structure-changing release is the **breaking new
major-structure release** that introduced `@nest-batch/core`,
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, and
`@nest-batch/bullmq` as sibling packages.

If you were on the pre-rename layout, the changes you need to make
are below. If you are adopting the package family fresh, this
document still matters: it lists what is **not** in this release so
you can decide whether the family meets your needs.

---

## TL;DR

- The library was split into four sibling packages.
- `@nest-batch/core` is now a dependency-light engine with stable
  public API.
- `@nest-batch/mikro-orm` and `@nest-batch/typeorm` each expose the
  batch meta table contract for their ORM.
- `@nest-batch/bullmq` provides the BullMQ transport strategy.
- `@nest-batch/drizzle` is **not in this release** (deferred).
- No admin UI, metrics, tracing, webhooks, or job visualization are
  shipped or promised.

---

## Package split

The previous `@nest-batch/nest-batch` package became four:

| Old location                                 | New package             |
| -------------------------------------------- | ----------------------- |
| `@nest-batch/nest-batch` (engine)            | `@nest-batch/core`      |
| `@nest-batch/nest-batch` (MikroORM bindings) | `@nest-batch/mikro-orm` |
| `@nest-batch/nest-batch` (TypeORM bindings)  | `@nest-batch/typeorm`   |
| `@nest-batch/nest-batch` (BullMQ transport)  | `@nest-batch/bullmq`    |

### Steps to migrate

1. **Update `package.json`.** Replace `@nest-batch/nest-batch`
   with the packages you actually need. The minimum is
   `@nest-batch/core`. Add the persistence and transport packages
   on top.

   ```diff
   - "@nest-batch/nest-batch": "x.y.z"
   + "@nest-batch/core": "0.1.0",
   + "@nest-batch/mikro-orm": "0.1.0",
   + "@nest-batch/bullmq": "0.1.0"
   ```

2. **Move persistence bindings.** If you were using the built-in
   MikroORM repository, switch to the one in
   `@nest-batch/mikro-orm`:

   ```ts
   import { MikroORMJobRepository, MikroORMTransactionManager } from '@nest-batch/mikro-orm';

   providers: [
     { provide: JobRepository, useClass: MikroORMJobRepository },
     { provide: TransactionManager, useClass: MikroORMTransactionManager },
   ];
   ```

   The `@nest-batch/typeorm` equivalent looks the same with
   `TypeOrmJobRepository` / `TypeOrmTransactionManager`.

3. **Wire the BullMQ transport if you need it.** Adding
   `BullmqBatchModule.forRoot({ connection, autoStartWorker })` is
   the only change needed to switch the launcher from in-process
   to BullMQ. The `JobLauncher.launch()` API does not change.

4. **Spread batch meta entities into your ORM config.** Each
   adapter package exports a `BATCH_META_ENTITIES` (or
   `batchMetaEntities`) tuple. Spread it into your `entities` list
   and generate/run the migration in your consuming app's own ORM
   workflow.

5. **Update imports.** The re-export surface moved. Decorators
   live under the `Batch` namespace from the core
   package. Interfaces stay reachable as bare names from
   `core/item`. `BatchDecorators` remains available as a backward-compatible
   alias.

### What did NOT change

- The Spring Batch-like Job/Step/Chunk/Tasklet/Reader/Processor/Writer
  conceptual model is unchanged.
- The `@Jobable` / `@ItemReader` / `@ItemProcessor` / `@ItemWriter`
  / `@Tasklet` decorator names are unchanged.
- The listener decorator names are unchanged.
- The `JobLauncher.launch(jobId, params)` API is unchanged.
- The public `IJobRepository` contract is unchanged.
- The chunk transaction, skip, restart, and checkpoint semantics
  are unchanged.

---

## Public API stabilization

The following parts of `@nest-batch/core` are **stable** in this
release. Breaking changes to them will only happen in a future
major version, with a deprecation period where the old shape is
preserved as an alias.

### Polymorphic `JobLauncher` strategy

```ts
export const EXECUTION_STRATEGY: symbol = Symbol.for('@nest-batch/core/EXECUTION_STRATEGY');

export interface IExecutionStrategy {
  readonly name: string;
  launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult>;
}

export type LaunchResult =
  | { readonly kind: 'completed'; readonly status: JobStatus }
  | { readonly kind: 'enqueued'; readonly queueJobId: string };
```

The symbol-based token, the strategy interface, the launch context
shape, and the discriminated launch result are all part of the
stable contract. Sibling packages are free to add new
`IExecutionStrategy` implementations (and the bullmq package does),
but the surface that consumers depend on will not change.

### Listener API

The listener decorators, the resolver map, the
`nonCritical: true` opt-in, and the per-kind / per-phase dispatch
table are stable. The set of listener kinds is the canonical list
in [`packages/core/README.md`](./packages/core/README.md). New
kinds will be additive (new decorator names, not changed names).

### Cron decorator API

```ts
export type BatchOverlapPolicy = 'skip' | 'queue' | 'parallel';

export interface BatchScheduledOptions {
  name: string;
  timezone: string;
  overlap?: BatchOverlapPolicy;
  startAt?: Date;
  endAt?: Date;
  inert?: boolean;
}

export function BatchScheduled(
  cronExpression: string,
  options: BatchScheduledOptions,
): MethodDecorator;
```

The `@BatchScheduled` decorator, the `BatchOverlapPolicy`, and the
`BatchScheduledOptions` shape are stable. The `inert` mode
(controlled by `BATCH_SCHEDULED_DISABLE=1` at decoration time) is
the documented test escape hatch and will not change.

### Module wiring

`NestBatchModule.forRoot()` / `forRootAsync()`, the
`JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` /
`EXECUTION_STRATEGY` / `BATCH_SCHEDULE_REGISTRY` /
`MODULE_OPTIONS_TOKEN` symbols, and the `extraProviders` /
`repository` / `transactionManager` / `executionStrategy` override
slots are stable. Adapters can extend the options bag through
`AdapterOptions`; core will preserve their fields.

---

## Peer dependency boundaries

Each adapter package declares its own peer dependencies. The peer
ranges are hard-pinned; you cannot install a host on the wrong
major and have it work.

| Package                 | Peer dependency         | Range     |
| ----------------------- | ----------------------- | --------- |
| `@nest-batch/core`      | `@nestjs/common`        | `^11.0.0` |
| `@nest-batch/core`      | `@nestjs/core`          | `^11.0.0` |
| `@nest-batch/core`      | `reflect-metadata`      | `^0.2.2`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/core`       | `^6.0.0`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/nestjs`     | `^6.0.0`  |
| `@nest-batch/mikro-orm` | `@mikro-orm/postgresql` | `^6.0.0`  |
| `@nest-batch/typeorm`   | `typeorm`               | `^1.0.0`  |
| `@nest-batch/bullmq`    | `bullmq`                | `^5.0.0`  |

`@nest-batch/core` does **not** declare a peer dependency on
`bullmq`, `mikro-orm`, `typeorm`, `drizzle-orm`, or `cron`. The
core boundary test fails the build if a forbidden package shows
up as a core import.

TypeORM 0.3 is intentionally not supported. The `typeorm: ^1.0.0`
peer range in `@nest-batch/typeorm` will not be widened. If you
need 0.3 support, stay on the previous
`@nest-batch/nest-batch` package (pre-rename).

MikroORM 5 is not supported either. The
`@mikro-orm/*: ^6.0.0` peer range is locked.

---

## What is NOT in this release (forward-pointer)

The 0.1.0 "What is NOT in this release" section has been
superseded by [`docs/RELEASE-0.2.0.md`](./docs/RELEASE-0.2.0.md),
which lists the actual 0.2.0 status of Drizzle, Kafka, Prisma,
MySQL, webhooks, partitioning, and the 0.3.0 roadmap.

---

## Closing notes

- Versions across the `@nest-batch/*` family are **lockstep**
  (`0.1.0` for the four shipped in 0.1.0; `0.2.0` for all ten in
  0.2.0). Bumping one will bump the rest. This avoids the
  "core 0.1.0 with bullmq 0.3.0 is broken" trap and keeps the
  contract suite meaningful. See
  [`docs/RELEASE-0.2.0.md`](./docs/RELEASE-0.2.0.md) §2 for the
  full 10-package list.
- The boundary test in core
  (`packages/core/tests/core/boundary/no-forbidden-imports.test.ts`)
  is the canary for accidental cross-contamination between
  packages. If a future change adds `bullmq` to core, that test
  fails the build.
- Anything that was an "open question" at plan time and is still
  open is out of scope for this release. Open a follow-up plan.

---

## Adapter slimming: DB adapters no longer bootstrap the third-party module

> **Breaking change in 0.2.0** (pre-1.0 semver, minor bump). The
> `0.1.0` → `0.2.0` step is the documented boundary for this
> shape change. Adapters are no longer "module bundles" that
> register the third-party connection module themselves. They
> are binding-only carriers, exactly like `InProcessAdapter`
> always was.

### What changed

`MikroOrmAdapter.forRoot()` and `TypeOrmAdapter.forRoot()` are
now **no-arg factories**. The adapter no longer accepts the
`MikroOrmModuleOptions` / `TypeOrmModuleOptions` payload, no
longer calls `MikroOrmModule.forRoot()` /
`TypeOrmModule.forRoot()` internally, and no longer merges
`BATCH_META_ENTITIES` / `batchMetaEntities` into the entities
list for you. The host owns the connection. The host also owns
the spread of the meta entities into the host's own `entities`
array.

`InProcessAdapter.forRoot()` has always been a no-arg factory.
The two DB adapters now match that shape, so every adapter in
the family follows the same `BatchAdapter` contract: a name, a
module carrier, and a list of global providers. There is no
longer a "DB adapters bootstrap the connection, everything
else is binding-only" special case.

### Why

Aligns both DB adapters with the `InProcessAdapter` shape
(already true-adapter-shaped). Removes the "module bundle"
responsibility from the adapter contract. The third-party
connection module is the host's concern, not the adapter's.
The adapter's job is to bind the `JOB_REPOSITORY_TOKEN` and
`TRANSACTION_MANAGER_TOKEN` symbols to the concrete
`JobRepository` and `TransactionManager` classes. It does not
own the connection that backs them.

### Before / after `AppModule`

**Before (0.1.0):** the adapter accepted the connection
options as its first argument and bootstrapped the third-party
connection module internally:

- `adapters.persistence` was a single `forRoot()` call that
  took the full `MikroOrmModuleOptions` /
  `TypeOrmModuleOptions` payload.
- The adapter merged `BATCH_META_ENTITIES` /
  `batchMetaEntities` into the `entities` array for you.
- The adapter registered `MikroOrmModule.forRoot()` /
  `TypeOrmModule.forRoot()` as a sub-import.
- The host did NOT import the third-party module class
  directly.

**After (0.2.0):** the host calls
`MikroOrmModule.forRoot()` (or `TypeOrmModule.forRoot()`)
directly, spreads the meta-entities tuple into the `entities`
array, and passes the no-arg adapter factory to
`NestBatchModule.forRoot()`:

```ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NestBatchModule, InProcessAdapter } from '@nest-batch/core';
import { BATCH_META_ENTITIES, MikroOrmAdapter } from '@nest-batch/mikro-orm';
import { BullmqAdapter } from '@nest-batch/bullmq';
import { ProductEntity } from './entities/product.entity';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      dbName: process.env.DATABASE_NAME,
      host: process.env.DATABASE_HOST,
      // ...rest of MikroORM config
    }),
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

The TypeORM version is the same shape with
`@nestjs/typeorm` / `TypeOrmModule.forRoot()` and
`batchMetaEntities` instead of `BATCH_META_ENTITIES`.

### Critical reminders

- **`BATCH_META_ENTITIES` spread is now load-bearing.**
  Forgetting the `...BATCH_META_ENTITIES` (or
  `...batchMetaEntities()` for TypeORM) spread in the host's
  `entities` array means the batch meta tables are not
  registered with the ORM's metadata system. The app boots
  cleanly, the batch module compiles, and the repository
  throws at first call with
  `relation "batch_job_instance" does not exist` (PostgreSQL)
  or the TypeORM equivalent. There is no warning at boot
  time. The failure is deferred until the first job
  execution.

- **`MikroOrmModule.forRoot()` must be `isGlobal: true` (the
  default).** `@mikro-orm/nestjs` registers the `EntityManager`
  on the host's module. The adapter is registered as
  `global: true`. When the host's `MikroOrmModule.forRoot()`
  is also `global: true` (the default), the `EntityManager`
  token crosses the module boundary cleanly. Setting
  `isGlobal: false` on the host's call silently breaks
  `EntityManager` injection inside the adapter's own module
  because the `EntityManager` is no longer exported across
  the boundary. There is no warning. Leave it at the default
  unless you have wired an alternative.

- **`TypeOrmModule.forRoot()` has the same `isGlobal`
  requirement.** Same mechanism, same default, same
  silent-break pattern. The adapter assumes the default
  `isGlobal: true`.

### Async config

Use `XxxModule.forRootAsync({...})` directly for async config
(e.g. when the connection comes from a `ConfigModule` or a
secret manager). The standard Nest async-module API is the
entry point. `MikroOrmAdapter.forRoot()` and
`TypeOrmAdapter.forRoot()` stay no-arg in async mode too. The
adapter does not care how the connection is built.

### See also

The full wiring walkthrough with the warning callouts lives in
each adapter's README:

- [`packages/mikro-orm/README.md`](./packages/mikro-orm/README.md#wiring)
- [`packages/typeorm/README.md`](./packages/typeorm/README.md#wiring)

---

## Validated package boundaries (0.1.0)

Each package in the family was packed with `pnpm pack --pack-destination /tmp/task23-pack --json` and the resulting tarball was inspected. Every package exits 0 and the file list is restricted to runtime + source + README. The full per-package log lives in
[`.omo/evidence/task-23-pack-dry-run.txt`](.omo/evidence/task-23-pack-dry-run.txt).

### Peer-dependency ranges (declared in `package.json`, verified post-pack)

| Package                 | Peer dep                | Range          | Notes                       |
| ----------------------- | ----------------------- | -------------- | --------------------------- |
| `@nest-batch/core`      | `@nestjs/common`        | `^10 \|\| ^11` |                             |
|                         | `@nestjs/core`          | `^10 \|\| ^11` |                             |
|                         | `reflect-metadata`      | `^0.2`         |                             |
| `@nest-batch/mikro-orm` | `@nest-batch/core`      | `workspace:*`  | resolved to `0.1.0` on pack |
|                         | `@mikro-orm/core`       | `^6.0.0`       | MikroORM 6.x only           |
|                         | `@mikro-orm/nestjs`     | `^6.0.0`       |                             |
|                         | `@mikro-orm/postgresql` | `^6.0.0`       |                             |
|                         | `@nestjs/common`        | `^10 \|\| ^11` |                             |
| `@nest-batch/typeorm`   | `@nest-batch/core`      | `workspace:*`  | resolved to `0.1.0` on pack |
|                         | `@nestjs/common`        | `^10 \|\| ^11` |                             |
|                         | `@nestjs/typeorm`       | `^10 \|\| ^11` |                             |
|                         | `typeorm`               | `^1.0.0`       | **NOT 0.3.x** — 1.0.0-only  |
| `@nest-batch/bullmq`    | `@nest-batch/core`      | `workspace:*`  | resolved to `0.1.0` on pack |
|                         | `@nestjs/common`        | `^10 \|\| ^11` |                             |
|                         | `@nestjs/core`          | `^10 \|\| ^11` |                             |
|                         | `bullmq`                | `^5.0.0`       | BullMQ 5.x only             |

`@nest-batch/drizzle` is **not** in this release. No package directory, no `workspace:*` reference, no import. The full check is in
[`.omo/evidence/task-23-no-drizzle.txt`](.omo/evidence/task-23-no-drizzle.txt).

### `files` allow-list (what ends up in the tarball)

Every package ships the same shape:

```json
"files": [
  "dist/src",          // compiled .js + .js.map + .d.ts
  "src",               // TypeScript source
  "README.md"          // package README
]
```

`@nest-batch/core` adds `"dist/tests/contracts"` to its list because the `./test-contracts` subpath export is part of the public API (it ships the shared contract suite adapter tests for downstream adapters).

The pack output never contains:

- `node_modules/`
- `coverage/`
- `dist/**/*.test.*` (test sources)
- `tests/**` (test sources — except `dist/tests/contracts` for core, which IS shipped)
- `tsconfig.json`, `vitest.config.ts`, debug scripts, etc.

### Pack-dry-run result (0.1.0)

| Package                 | Total files | Has dist/ | Has src/ | Has README.md | Test/coverage/node_modules | Exit |
| ----------------------- | ----------- | --------- | -------- | ------------- | -------------------------- | ---- |
| `@nest-batch/core`      | 395         | ✓         | ✓        | ✓             | 0                          | 0    |
| `@nest-batch/mikro-orm` | 52          | ✓         | ✓        | ✓             | 0                          | 0    |
| `@nest-batch/typeorm`   | 20          | ✓         | ✓        | ✓             | 0                          | 0    |
| `@nest-batch/bullmq`    | 33          | ✓         | ✓        | ✓             | 0                          | 0    |

Reproduce locally:

```bash
mkdir -p /tmp/task23-pack && rm -f /tmp/task23-pack/*.tgz
for pkg in core mikro-orm typeorm bullmq; do
  pnpm --filter "@nest-batch/$pkg" pack --pack-destination /tmp/task23-pack --json
done
ls -la /tmp/task23-pack/
```

(`pnpm pack` does not support `--dry-run`. The `--json` flag is the closest equivalent: it prints the full file list, while `--pack-destination` redirects the resulting tarball out of the workspace.)

### Files-allow-list rationale

- `dist/src` is the runtime artifact (`main: "dist/src/index.js"`, `types: "dist/src/index.d.ts"`). It is the only thing an end-user import actually loads.
- `src` ships so that downstream adapters (and the `@nest-batch/core/test-contracts` consumer) can read the original TypeScript to align with the published public API surface. It is also the source for the `.d.ts.map` source maps.
- `README.md` is the package's per-package documentation.
- We deliberately do **not** ship `tests/` (except `dist/tests/contracts` for core). The contract suite is the _interface_, not the test. Downstream adapters import the compiled contracts from `@nest-batch/core/test-contracts`; the raw test sources are not part of the published boundary.
- `tsconfig.json`, `vitest.config.ts`, `.swcrc`, debug scripts, and editor scratch files are excluded by the `files` allow-list.
