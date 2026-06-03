# nest-batch

A NestJS batch processing framework, modelled after Spring Batch, split
into a small set of focused sibling packages. The repo is a pnpm
workspace with the library packages under `packages/` and a consumer
demo under `apps/demo`.

This is a **breaking new major-structure release**. The previous
single-package `@nest-batch/nest-batch` is gone; the
`@nest-batch/core` engine now lives in its own package, and the
persistence and transport integrations have moved into sibling
packages. See [`MIGRATION.md`](./MIGRATION.md) for the full
breakdown.

---

## Further reading

- [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) — bring the repo up
  locally in five minutes: install, Postgres + Redis, test suites,
  env-var matrix.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the four
  design principles (BullMQ-as-runtime, DB-first state, step /
  partition granularity, business vs technical retry) and the
  tests that enforce them.
- [`docs/FAQ.md`](./docs/FAQ.md) — common questions (Drizzle,
  TypeORM 0.3, chunking ownership, JobExecution canonical store,
  scheduling).
- [`MIGRATION.md`](./MIGRATION.md) — breaking changes and the
  explicit "what is NOT in this release" list.

---

## The `@nest-batch/*` package family

```
@nest-batch/core        ← the batch engine (Job/Step/Chunk/Tasklet, checkpoint, restart, skip, retry)
        ▲
        │
@nest-batch/mikro-orm   ← MikroORM 6.x adapter + 6 batch meta tables + migrations
@nest-batch/typeorm     ← TypeORM 1.0.0 adapter + the same 6 tables + migration
@nest-batch/bullmq      ← BullMQ transport strategy (Queue/Worker/QueueEvents lifecycle)
```

Each adapter is a sibling. They depend on `@nest-batch/core`; they
do not depend on each other. There is no admin UI package, no
metrics package, no Drizzle package. The list above is the full
list in this release.

### Where things live

| Concern                          | Package                 |
| -------------------------------- | ----------------------- |
| Job/Step/Chunk/Tasklet IR        | `@nest-batch/core`      |
| `@Jobable`, `@ItemReader`, ...   | `@nest-batch/core`      |
| `@BatchScheduled` cron decorator | `@nest-batch/core`      |
| Listener system                  | `@nest-batch/core`      |
| Skip / retry policies            | `@nest-batch/core`      |
| Shared contract suite            | `@nest-batch/core`      |
| `JobLauncher`, `JobExecutor`     | `@nest-batch/core`      |
| `IExecutionStrategy` (in-proc)   | `@nest-batch/core`      |
| PostgreSQL via MikroORM 6        | `@nest-batch/mikro-orm` |
| PostgreSQL via TypeORM 1.0.0     | `@nest-batch/typeorm`   |
| BullMQ transport                 | `@nest-batch/bullmq`    |
| **Drizzle**                      | **not in this release** |
| Admin UI                         | **not in this release** |
| Metrics / tracing / webhook      | **not in this release** |

Read the per-package README for the contract, the peer
dependencies, and the wiring snippet:

- [`packages/core/README.md`](./packages/core/README.md)
- [`packages/mikro-orm/README.md`](./packages/mikro-orm/README.md)
- [`packages/typeorm/README.md`](./packages/typeorm/README.md)
- [`packages/bullmq/README.md`](./packages/bullmq/README.md)

---

## Workspace layout

```
nest-batch/
├── packages/
│   ├── core/                # @nest-batch/core
│   ├── mikro-orm/           # @nest-batch/mikro-orm
│   ├── typeorm/             # @nest-batch/typeorm
│   └── bullmq/              # @nest-batch/bullmq
└── apps/
    └── demo/                # @nest-batch/demo (consumer Nest app)
```

All packages extend the root `tsconfig.base.json`, share the root
`.swcrc` for compilation, and use the root `vitest.config.ts` (or
their own per-package config) for testing.

---

## Tooling

- **Package manager:** pnpm@10 (workspaces)
- **Language:** TypeScript 5.7 (strict, NodeNext modules, ES2022 target)
- **Decorator support:** `experimentalDecorators` + `emitDecoratorMetadata` (NestJS-compatible)
- **Compiler:** SWC (`.swcrc` at root) for fast TS → CJS transpilation
- **Tests:** Vitest with v8 coverage (80% threshold)
- **Lint:** ESLint with `@typescript-eslint` + `eslint-plugin-import`
- **Format:** Prettier (single quote, trailing comma `all`, 100 cols)
- **Node:** `>=20` (Node 24 supported). Volta pins both `node` and `pnpm` versions in this repo.

---

## Local development setup

> Looking for the **full** runbook (test commands, e2e suites, env
> var matrix)? See
> [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). The section below
> covers the install + services + migrations path needed to boot
> the demo; the runbook covers the test suites too.

### 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

The lockfile pins every workspace and peer dependency. If you need
to add a dependency, run `pnpm install` (without `--frozen-lockfile`)
and commit the updated `pnpm-lock.yaml`.

### 2. Start the local services

The repo's `docker-compose.yml` brings up Postgres and Redis:

```bash
docker compose up -d
# or, to bring up one at a time:
docker compose up -d postgres
docker compose up -d redis
```

The default ports are `5434` (Postgres) and `6379` (Redis). The
demo app and the integration tests connect to these.

### 3. Run the migrations

The MikroORM migrations ship inside `@nest-batch/mikro-orm` and
are applied by the demo app's `migration:up` script (which loads
`@nest-batch/mikro-orm`'s `createBatchMikroOrmConfig` helper
internally):

```bash
pnpm --filter @nest-batch/demo migration:up
```

The TypeORM migration is bundled with `@nest-batch/typeorm` and is
applied via your host's standard TypeORM migration runner.

### 4. Environment variables

The demo app reads from `.env` (see `.env.example` for the full
list). The most important ones:

```env
# Postgres (matches docker-compose.yml)
DB_HOST=127.0.0.1
DB_PORT=5434
DB_USER=demo
DB_PASSWORD=demo
DB_NAME=nest_batch_demo

# Redis (matches docker-compose.yml)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_KEY_PREFIX=nest-batch:

# Batch scheduling (optional; see @BatchScheduled docs)
BATCH_SCHEDULED_DISABLE=0
```

Set `BATCH_SCHEDULED_DISABLE=1` to put cron-scheduled jobs into
inert mode for tests. The decorator captures this at decoration
time.

### 5. Verify

```bash
pnpm build       # builds every package
pnpm lint        # runs ESLint per package
pnpm typecheck   # tsc --noEmit per package
pnpm test        # vitest run per package (unit + contract)
```

The CI workflow at `.github/workflows/ci.yml` runs the same four
commands. The local run should match CI exactly.

---

## Quickstart

A minimal app that wires the three packages together (core + MikroORM

- BullMQ) looks like this.

### 1. Install

```bash
pnpm add @nest-batch/core @nest-batch/mikro-orm @nest-batch/bullmq \
         @nestjs/common @nestjs/core @mikro-orm/core @mikro-orm/nestjs \
         @mikro-orm/postgresql bullmq
```

### 2. Module

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  NestBatchModule,
  JobRepository,
  TransactionManager,
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
} from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  MikroORMJobRepository,
  MikroORMTransactionManager,
} from '@nest-batch/mikro-orm';
import { BullmqBatchModule } from '@nest-batch/bullmq';
import { ProductEntity } from './entities/product.entity';
import { ImportProductsJob } from './jobs/import-products.job';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      dbName: process.env.DB_NAME,
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    }),
    NestBatchModule.forRoot(),
    BullmqBatchModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        keyPrefix: process.env.REDIS_KEY_PREFIX,
      },
      autoStartWorker: true,
    }),
  ],
  providers: [
    { provide: JobRepository, useClass: MikroORMJobRepository },
    { provide: TransactionManager, useClass: MikroORMTransactionManager },
    InProcessExecutionStrategy,
    IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
    ImportProductsJob,
  ],
})
export class AppModule {}
```

`BullmqBatchModule` overrides the `EXECUTION_STRATEGY` token at the
DI boundary, so `JobLauncher.launch()` now enqueues into BullMQ
without any change to the controller code. Drop
`BullmqBatchModule` from the `imports` and you're back to in-process
execution.

### 3. Job

```ts
// src/jobs/import-products.job.ts
import { Injectable } from '@nestjs/common';
import { Jobable, ItemReader, ItemProcessor, ItemWriter, BatchDecorators } from '@nest-batch/core';

@Injectable()
@Jobable({ id: 'import-products' })
export class ImportProductsJob {
  @BatchDecorators.ItemReader()
  async read(): Promise<ProductRow | null> {
    // Read one row at a time from the input source.
  }

  @BatchDecorators.ItemProcessor()
  async process(row: ProductRow): Promise<Product | null> {
    // Transform / validate / skip.
  }

  @BatchDecorators.ItemWriter()
  async write(items: Product[]): Promise<void> {
    // Persist a chunk.
  }
}
```

### 4. Launch

```ts
// src/controller/batch.controller.ts
import { Controller, Post } from '@nestjs/common';
import { JobLauncher } from '@nest-batch/core';

@Controller('jobs')
export class BatchController {
  constructor(private readonly launcher: JobLauncher) {}

  @Post('import-products')
  async importProducts() {
    return this.launcher.launch('import-products', { source: 'sample.csv' });
  }
}
```

The launcher returns the latest persisted `JobExecution`. With the
in-process strategy the `status` is the terminal state; with the
BullMQ strategy the `status` is `STARTING` / `STARTED` and the rest
of the lifecycle is driven by the worker.

### 5. Run

```bash
pnpm --filter @nest-batch/demo start
# In a second terminal, trigger a launch. The body MUST contain a
# `file` field; the demo's CSV reader uses it as the input path.
curl -X POST http://localhost:3000/jobs/import-products \
  -H 'content-type: application/json' \
  -d '{"file":"sample-data/products-valid.csv"}'
```

---

## Migration from `@nest-batch/nest-batch` (pre-rename)

The previous single-package layout is gone. If you depend on the
old package name, you need to:

1. Replace `@nest-batch/nest-batch` with `@nest-batch/core` in your
   `package.json`.
2. Move persistence bindings (`JobRepository`,
   `TransactionManager`) to `@nest-batch/mikro-orm` or
   `@nest-batch/typeorm`.
3. If you used the built-in queue, move to
   `@nest-batch/bullmq`.
4. Update imports — the new layout re-exports through the package
   root, but the underlying module structure has changed.

Read [`MIGRATION.md`](./MIGRATION.md) for the full list of
breaking changes and the explicit "what is NOT in this release"
items (Drizzle, admin UI, metrics, tracing, webhooks, job
visualization).

---

## Common scripts

| Script                      | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `pnpm build`                | Build every workspace package (`-r`).          |
| `pnpm test`                 | Run tests across all workspace packages.       |
| `pnpm lint`                 | Lint all workspace packages.                   |
| `pnpm typecheck`            | `tsc --noEmit` per package via `pnpm -r exec`. |
| `pnpm format`               | Prettier write across the repo.                |
| `pnpm format:check`         | Prettier check (CI-friendly).                  |
| `pnpm --filter <pkg> test`  | Run one package's test suite.                  |
| `pnpm --filter <pkg> build` | Build one package.                             |

---

## Status

This is the **breaking new major-structure release** of the
package family. The engine, the adapters, and the BullMQ transport
are all wired up. What's still on the roadmap is the optional
scheduler (cron-style jobs that actually fire, not just register
metadata), partitioning for chunked steps, and (eventually) the
Drizzle adapter that this release explicitly defers.
