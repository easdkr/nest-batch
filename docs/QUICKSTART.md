# Quickstart

Bring the repo up locally in five minutes. Everything below assumes
macOS / Linux with `docker` and `pnpm@10` already installed. Every
command is a literal copy of what works on a clean checkout today.

> Looking for how to **use** the family from a consumer app? That lives
> in the root [`README.md`](../README.md) and the per-package READMEs:
> [`core`](../packages/core/README.md),
> [`mikro-orm`](../packages/mikro-orm/README.md),
> [`typeorm`](../packages/typeorm/README.md),
> [`bullmq`](../packages/bullmq/README.md). This file is the **local
> dev runbook** for the repo itself.

---

## 1. Install dependencies (5 lines)

```bash
git clone <repo-url> nest-batch
cd nest-batch
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles every package via SWC and emits `.d.ts`
declarations. Required once before running the demo or the test
suites — `@nest-batch/demo` resolves its workspace siblings off
`dist/`.

---

## 2. Bring up Postgres + Redis

The repo ships a `docker-compose.yml` at the root with both services
and their healthchecks. Bring them up:

```bash
docker compose up -d                      # postgres + redis together
docker compose ps                         # confirm both are healthy
```

To bring up one at a time (e.g. you only need Postgres for the
MikroORM contract suite):

```bash
docker compose up -d postgres
docker compose up -d redis
```

Defaults match the `.env.example`:

| Service  | Image                | Host port |
| -------- | -------------------- | --------- |
| postgres | `postgres:16-alpine` | `5434`    |
| redis    | `redis:7-alpine`     | `6379`    |

Sanity-check Redis and Postgres separately:

```bash
docker compose exec -T redis   redis-cli ping              # → PONG
docker compose exec -T postgres pg_isready -U demo        # → accepting connections
```

---

## 3. Apply the batch meta-schema

The MikroORM migrations live in `@nest-batch/mikro-orm`. The demo's
`migration:up` script loads the adapter's `createBatchMikroOrmConfig`
helper and runs them. Run it once after the first `docker compose up`:

```bash
pnpm --filter @nest-batch/demo migration:up
# → "Pending migrations: 4" then "All migrations applied."
```

The TypeORM adapter ships its own migration as
`CreateBatchMeta1700000000000`. Hosts with their own TypeORM migration
directory copy the file in and renumber it; the demo app does not
exercise the TypeORM adapter, so there is no `migration:up` script in
`apps/demo` for it.

---

## 4. Run the test suites

Three suites, three commands. Each assumes the corresponding services
are up.

### Unit + contract (no external services required)

```bash
pnpm test
```

This runs every workspace package's `vitest run`. Coverage is part of
the run for packages that configure v8 thresholds.

### End-to-end (PostgreSQL required)

The end-to-end suites hit a real `JobRepository` against the
docker-compose Postgres. Bring Postgres up first.

```bash
# Demo app non-BullMQ e2e (in-process launcher against Postgres)
pnpm --filter @nest-batch/demo test:e2e

# @nest-batch/mikro-orm contract suite (Postgres, runs all 25
# repository / transaction-manager contract assertions).
pnpm --filter @nest-batch/mikro-orm test:e2e

# @nest-batch/core library smoke (in-memory, no Postgres required,
# but grouped here because it is part of the e2e wave).
pnpm --filter @nest-batch/core test:e2e
```

### BullMQ end-to-end (PostgreSQL + Redis required)

The BullMQ e2e suite brings up a launcher + worker in the same
process, then asserts the full enqueue → consume → DB-update cycle.
With `BATCH_BULLMQ_AUTOSTART_WORKER=1`, that process also starts the
schedule-queue bridge that turns `@BatchScheduled` fires into
`JobLauncher.launch(jobId, params)`. It needs both services.

```bash
docker compose up -d                    # postgres + redis
pnpm --filter @nest-batch/demo test:e2e:bullmq
```

The suite uses `BATCH_BULLMQ_AUTOSTART_WORKER=1` and a per-PID
`BATCH_BULLMQ_KEY_PREFIX` so parallel runs do not collide on shared
Redis state. The setup file
`apps/demo/test/bullmq-e2e-setup.ts` sets both before the
`AppModule` decorator is evaluated.

---

## 5. Run the demo app

With Postgres + Redis up and the migrations applied:

```bash
# Launcher-only deployment (default; a separate worker would consume
# the BullMQ queue in production).
pnpm --filter @nest-batch/demo start
```

For queue-backed cron execution, the `@BatchScheduled` decorator
registers the schedule and the BullMQ schedule bridge turns each cron
fire into `JobLauncher.launch('import-products', { scheduled: true,
scheduleName, scheduledAt, ... })`. In the demo, start the BullMQ
workers in the same process:

```bash
BATCH_BULLMQ_AUTOSTART_WORKER=1 pnpm --filter @nest-batch/demo start
```

Scheduled `import-products` launches use `IMPORT_FILE` when the cron
trigger does not provide a `file` launch parameter. Manual/API launches
should still pass `file` explicitly.

Trigger a job from a second terminal. The body MUST include a `file`
field; the controller returns `400 Missing "file"` otherwise:

```bash
curl -X POST http://localhost:3000/jobs/import-products \
  -H 'content-type: application/json' \
  -d '{"file":"sample-data/products-valid.csv"}'
```

Run the same launch in-process (no Redis required). Set the env var
in the same shell as the `start` command:

```bash
BATCH_TRANSPORT=in-process pnpm --filter @nest-batch/demo start
# In another terminal:
curl -X POST http://localhost:3000/jobs/import-products \
  -H 'content-type: application/json' \
  -d '{"file":"sample-data/products-valid.csv"}'
```

In `in-process` mode, `InProcessSchedule` also consumes
`@BatchScheduled` metadata and runs the cron loop inside that same
server process. This is suitable for one running process. If multiple
replicas start the same app, each replica has its own timer and can
launch the same schedule unless the host adds a leader election or
distributed lock.

In `in-process` mode the launcher's response carries the terminal
`status` (`COMPLETED` / `FAILED`). In `bullmq` mode the response is
`STARTING` / `STARTED` — the worker drives the rest of the lifecycle
in a separate process.

---

## Environment variable matrix

The full set the demo app reads. Defaults are baked into
`apps/demo/src/app.module.ts`; `.env.example` is the documented
shape.

| Variable                        | Default                          | Read by                             | Purpose                                                                                                                              |
| ------------------------------- | -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                          | `3000`                           | `main.ts`                           | HTTP listen port for the demo REST controller.                                                                                       |
| `DATABASE_HOST`                 | `localhost`                      | demo app, migration script          | PostgreSQL host. Matches `docker-compose.yml`.                                                                                       |
| `DATABASE_PORT`                 | `5434`                           | demo app, migration script          | PostgreSQL host port.                                                                                                                |
| `DATABASE_NAME`                 | `nest_batch_demo`                | demo app, migration script          | PostgreSQL database.                                                                                                                 |
| `DATABASE_USER`                 | `demo`                           | demo app, migration script          | PostgreSQL user.                                                                                                                     |
| `DATABASE_PASSWORD`             | `demo`                           | demo app, migration script          | PostgreSQL password.                                                                                                                 |
| `BATCH_TRANSPORT`               | `bullmq`                         | `app.module.ts`                     | `bullmq` (default) or `in-process`. Anything other than the literal string `in-process` is treated as `bullmq`.                      |
| `REDIS_HOST`                    | `127.0.0.1`                      | `@nest-batch/bullmq` (via demo app) | Redis host. Only used when `BATCH_TRANSPORT=bullmq`.                                                                                 |
| `REDIS_PORT`                    | `6379`                           | `@nest-batch/bullmq` (via demo app) | Redis port.                                                                                                                          |
| `REDIS_KEY_PREFIX` (optional)   | `nest-batch:`                    | `@nest-batch/bullmq`                | BullMQ key namespace. Defaults to `nest-batch:` inside the adapter when unset. The e2e suite overrides it per-PID.                   |
| `IMPORT_FILE`                   | `sample-data/products-valid.csv` | `ImportProductsJob`                 | Fallback CSV path when launch params omit `file`. Production launches should pass `file` in the REST request body.                   |
| `BATCH_SCHEDULED_DISABLE`       | unset (`0`)                      | `@BatchScheduled` decorator         | Set to `1` to make `@BatchScheduled` stamp `inert: true` at decoration time. Test-only escape hatch.                                 |
| `BATCH_BULLMQ_AUTOSTART_WORKER` | unset (`false`)                  | demo app (`AppModule`)              | Set to `1` to start BullMQ runtime and schedule bridge workers in the demo process. Test-only; the demo is launcher-only by default. |
| `BATCH_BULLMQ_KEY_PREFIX`       | unset                            | demo app (`AppModule`)              | Overrides the `REDIS_KEY_PREFIX` style namespace the BullMQ transport uses. Test-only; lets the e2e suite isolate concurrent runs.   |

Set `BATCH_SCHEDULED_DISABLE=1` to put cron-scheduled jobs into inert
mode for tests. The decorator captures this at decoration time, not
runtime.
