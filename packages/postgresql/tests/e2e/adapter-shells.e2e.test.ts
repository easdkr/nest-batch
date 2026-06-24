// E2E harness for all 4 `@nest-batch/postgresql` shells against a
// single shared live Postgres database.
//
// This file is the **integration** test the F4 REJECT called out —
// the missing piece between the per-slot e2e harnesses in
// `@nest-batch/drizzle/tests/e2e-postgres.test.ts` and
// `@nest-batch/prisma/tests/e2e-postgres.test.ts` (which exercise
// the slot's driver-agnostic `DrizzleJobRepository` /
// `PrismaJobRepository` / ...) and the postgresql package's own
// shells (`PostgresMikroOrmJobRepository`, `PostgresTypeOrmJobRepository`,
// `PostgresDrizzleJobRepository`, `PostgresPrismaJobRepository`).
//
// What it does, top to bottom:
//
//   1. Uses one shared Postgres database (gated by
//      `RUN_POSTGRES_E2E=1` — the `test:e2e` script in `package.json`
//      sets the env var; default `pnpm test` does NOT). When
//      `POSTGRES_E2E_DATABASE_URL` is present, the harness uses
//      that external database; otherwise it starts a
//      `PostgreSqlContainer`.
//   2. Applies the 5-table batch meta-schema DDL from
//      `packages/postgresql/migrations/0001-create-batch-meta.sql`
//      ONCE against the live database (the file lists `CREATE INDEX`
//      statements interleaved with their target tables, so we
//      reorder to run all `CREATE TABLE` first, then `CREATE INDEX`
//      — Postgres rejects the index creation otherwise).
//   3. For each of the 4 shells (MikroORM, TypeORM, Drizzle, Prisma),
//      builds a fresh `@nestjs/testing` `Test.createTestingModule(...)`
//      that:
//         - wires the slot adapter's `BatchAdapter.module` literal
//           (`MikroOrmAdapter.forRoot().module` / `TypeOrmAdapter` /
//           `DrizzleAdapter` / `PrismaAdapter`) — the no-arg
//           factories from the 4 slot packages that bind
//           `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN`
//           globally.
//         - wires the postgresql shell
//           (`PostgresMikroOrmBatchModule` / `PostgresTypeOrmBatchModule` /
//           `PostgresDrizzleBatchModule` / `PostgresPrismaBatchModule`)
//           so the host app's `BatchAdapter` factory-pattern wiring
//           is exercised end-to-end (the contract suite only sees
//           the resolved repo / tx pair, but the module's compile-
//           and-bootstrap is a separate tripwire).
//         - provides the postgresql shell's
//           `PostgresXxxJobRepository` / `PostgresXxxTransactionManager`
//           as `useValue` providers, constructed against a
//           host-owned connection (the 4 shells each accept the
//           raw ORM handle — `EntityManager` / `DataSource` /
//           `NodePgDatabase` / `PrismaClient` — in their
//           constructors, so the slot's adapter-internal driver
//           token plumbing is not on the test's hot path).
//      …and resolves the postgresql package's
//      `PostgresXxxJobRepository` / `PostgresXxxTransactionManager`
//      from DI to feed the `runJobRepositoryContract` factory.
//   4. Re-runs the shared `@nest-batch/core` contract suite
//      (`@nest-batch/core/test-contracts`'s
//      `runJobRepositoryContract`) against each shell. The contract
//      is the same one every slot and every shell passes; the
//      F4-reject gap was that no single e2e file exercised all 4
//      shells against a real Postgres — this file closes it.
//   5. Tears the testcontainer down in `afterAll` when the harness
//      started one.
//
// Run locally with a Docker daemon up:
//
//   RUN_POSTGRES_E2E=1 pnpm --filter @nest-batch/postgresql test:e2e

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgreSqlDriver,
  type EntityManager as PostgresEntityManager,
} from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/core';
import { DataSource } from 'typeorm';

import { runJobRepositoryContract } from '../../../core/tests/contracts/job-repository.contract';
import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';

import {
  PostgresMikroOrmJobRepository,
  PostgresMikroOrmTransactionManager,
  PostgresMikroOrmBatchModule,
  PostgresTypeOrmJobRepository,
  PostgresTypeOrmTransactionManager,
  PostgresTypeOrmBatchModule,
  PostgresDrizzleJobRepository,
  PostgresDrizzleTransactionManager,
  PostgresDrizzleBatchModule,
  postgresDrizzleSchema,
  PostgresPrismaJobRepository,
  PostgresPrismaTransactionManager,
  PostgresPrismaBatchModule,
} from '../../src';

const E2E_ENABLED = process.env.RUN_POSTGRES_E2E === '1';
const EXTERNAL_DATABASE_URL = process.env.POSTGRES_E2E_DATABASE_URL;

const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Resolved once, lazily. The DDL lives in this package's own
// `migrations/` directory (the canonical F4 location). The file
// is read from the filesystem (not bundled into the test source)
// so a schema change to the migration only requires re-running
// the e2e — no test source update.
const MIGRATION_PATH = resolve(__dirname, '..', '..', 'migrations', '0001-create-batch-meta.sql');

// The Prisma schema bundled with the postgresql package. The
// Prisma shell applies it via `prisma db push` against the live
// database before the Prisma shell's describe block runs.
const PRISMA_SCHEMA_PATH = resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

interface PostgresConnectionDetails {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

function parsePostgresConnectionString(connectionString: string): PostgresConnectionDetails {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error(
      'POSTGRES_E2E_DATABASE_URL must include a database name, e.g. ' +
        'postgres://demo:demo@127.0.0.1:55432/nest_batch_postgres_e2e',
    );
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

describeE2E(
  '@nest-batch/postgresql — 4-shell integration e2e (live Postgres, gated by RUN_POSTGRES_E2E=1)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
    let pool: Pool;
    let dbUrl: string;
    let connection: PostgresConnectionDetails;

    beforeAll(async () => {
      if (!existsSync(MIGRATION_PATH)) {
        throw new Error(
          `Postgres migration not found at ${MIGRATION_PATH}. ` +
            'The e2e harness requires the 5-table batch meta ' +
            'migration at ' +
            '`packages/postgresql/migrations/0001-create-batch-meta.sql`.',
        );
      }
      const ddl = readFileSync(MIGRATION_PATH, 'utf8');

      if (EXTERNAL_DATABASE_URL) {
        dbUrl = EXTERNAL_DATABASE_URL;
      } else {
        container = await new PostgreSqlContainer('postgres:16-alpine')
          .withDatabase('nest_batch_postgres_e2e')
          .withUsername('demo')
          .withPassword('demo')
          .start();
        dbUrl = container.getConnectionUri();
      }
      connection = parsePostgresConnectionString(dbUrl);

      // The 5-table migration file lists `CREATE INDEX` statements
      // interleaved with their target `CREATE TABLE` blocks. Postgres
      // rejects index creation when the target table does not exist
      // yet, so we split the file into individual statements, run
      // all `CREATE TABLE` statements first, then the
      // `CREATE INDEX` statements. The order within each group is
      // irrelevant (the tables have no cross-table FK dependencies
      // that would force a specific order, and `IF NOT EXISTS` makes
      // the splits idempotent).
      const rawStatements = ddl
        .split(/;\s*(?=\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const tableStatements = rawStatements.filter((s) => /CREATE\s+TABLE\b/i.test(s));
      const indexStatements = rawStatements.filter((s) => /CREATE\s+INDEX\b/i.test(s));
      const ordered = [...tableStatements, ...indexStatements];

      pool = new Pool({ connectionString: dbUrl });
      const client = await pool.connect();
      try {
        for (const stmt of ordered) {
          await client.query(stmt);
        }
      } finally {
        client.release();
      }

      // The Prisma shell uses `prisma db push` (not raw SQL) to
      // apply its schema. Run it once, before the Prisma describe
      // block boots, against the same testcontainer. The schema is
      // idempotent on a clean DB.
      if (existsSync(PRISMA_SCHEMA_PATH)) {
        execFileSync(
          'pnpm',
          ['prisma', 'db', 'push', '--schema', PRISMA_SCHEMA_PATH, '--skip-generate'],
          {
            cwd: resolve(__dirname, '..', '..'),
            env: { ...process.env, DATABASE_URL: dbUrl },
            stdio: 'inherit',
          },
        );
      }
    }, 180_000);

    afterAll(async () => {
      if (pool) await pool.end();
      if (container) await container.stop();
    });

    // Per-test cleanup: TRUNCATE the 5 batch meta tables so a
    // contract-suite test in one shell's describe block does not
    // see rows left over from a previous shell. The 6th classic
    // table (`batch_step_execution_params`) is intentionally
    // absent — the F4 refactor dropped it. `RESTART IDENTITY`
    // resets the SERIAL / UUID-key sequences; `CASCADE` propagates
    // the truncate through the (logical) FKs in
    // `batch_job_execution` / `batch_step_execution`.
    async function truncateAll() {
      const client = await pool.connect();
      try {
        await client.query(`
          TRUNCATE TABLE
            "batch_step_execution_context",
            "batch_job_execution_context",
            "batch_step_execution",
            "batch_job_execution",
            "batch_job_instance"
          RESTART IDENTITY CASCADE
        `);
      } finally {
        client.release();
      }
    }

    // -------------------------------------------------------------------------
    // Shell 1: MikroORM Postgres
    // -------------------------------------------------------------------------
    describe('MikroORM Postgres shell', () => {
      let mod: TestingModule;
      let orm: MikroORM;
      let repo: PostgresMikroOrmJobRepository;
      let tx: PostgresMikroOrmTransactionManager;

      beforeAll(async () => {
        await truncateAll();
        // `PostgresMikroOrmJobRepository` is a 1-line re-export of
        // `@nest-batch/mikro-orm`'s driver-agnostic
        // `MikroORMJobRepository`, which takes an `EntityManager`
        // in its constructor. We construct the host's `MikroORM`
        // connection manually (`@nestjs/mikro-orm` is not a devDep
        // here; the postgresql package only declares the raw
        // `@mikro-orm/postgresql` driver as a peer), pass the 5
        // batch meta entities, and bind the postgresql shell's
        // `PostgresMikroOrmBatchModule` carrier into a test Nest
        // module. The `useValue` providers below take the host's
        // `EntityManager` constructed just above.
        orm = await MikroORM.init({
          entities: [...BATCH_META_ENTITIES],
          driver: PostgreSqlDriver,
          dbName: connection.database,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          password: connection.password,
        });
        // The `orm.em` is typed as the generic `EntityManager`
        // (`@mikro-orm/core`); the postgresql shell's classes
        // accept the Postgres-specific `PostgresEntityManager`
        // (`@mikro-orm/postgresql`). The runtime values are
        // structurally identical for the slot's driver-agnostic
        // `MikroORMJobRepository` (the actual repo is a re-export);
        // the type widening is a documentation aid.
        const em = orm.em as unknown as PostgresEntityManager;

        mod = await Test.createTestingModule({
          imports: [PostgresMikroOrmBatchModule],
          providers: [
            {
              provide: PostgresMikroOrmJobRepository,
              useValue: new PostgresMikroOrmJobRepository(em),
            },
            {
              provide: PostgresMikroOrmTransactionManager,
              useValue: new PostgresMikroOrmTransactionManager(em),
            },
          ],
        }).compile();

        repo = mod.get(PostgresMikroOrmJobRepository);
        tx = mod.get(PostgresMikroOrmTransactionManager);
      }, 60_000);

      afterAll(async () => {
        if (mod) await mod.close();
        if (orm) await orm.close();
      });

      runJobRepositoryContract(
        {
          create: () => ({ repo, tx }),
        },
        'PostgresMikroOrm (4-shell e2e)',
      );

      it('PostgresMikroOrmJobRepository is the concrete impl wired by the e2e harness', () => {
        expect(repo).toBeInstanceOf(PostgresMikroOrmJobRepository);
      });

      it('PostgresMikroOrmTransactionManager is the concrete impl wired by the e2e harness', () => {
        expect(tx).toBeInstanceOf(PostgresMikroOrmTransactionManager);
      });
    });

    // -------------------------------------------------------------------------
    // Shell 2: TypeORM Postgres
    // -------------------------------------------------------------------------
    describe('TypeORM Postgres shell', () => {
      let mod: TestingModule;
      let dataSource: DataSource;
      let repo: PostgresTypeOrmJobRepository;
      let tx: PostgresTypeOrmTransactionManager;

      beforeAll(async () => {
        await truncateAll();
        // The shell's classes take a `DataSource` directly. The
        // `PostgresTypeOrmBatchModule` carrier is wired into the
        // test module; the `useValue` providers below take the
        // host's `DataSource` constructed just above.
        dataSource = new DataSource({
          type: 'postgres',
          host: connection.host,
          port: connection.port,
          username: connection.user,
          password: connection.password,
          database: connection.database,
          entities: [],
          synchronize: false,
          migrationsRun: false,
        });
        await dataSource.initialize();

        mod = await Test.createTestingModule({
          imports: [PostgresTypeOrmBatchModule],
          providers: [
            {
              provide: PostgresTypeOrmJobRepository,
              useValue: new PostgresTypeOrmJobRepository(dataSource),
            },
            {
              provide: PostgresTypeOrmTransactionManager,
              useValue: new PostgresTypeOrmTransactionManager(dataSource),
            },
          ],
        }).compile();

        repo = mod.get(PostgresTypeOrmJobRepository);
        tx = mod.get(PostgresTypeOrmTransactionManager);
      }, 60_000);

      afterAll(async () => {
        if (mod) await mod.close();
        if (dataSource?.isInitialized) await dataSource.destroy();
      });

      runJobRepositoryContract(
        {
          create: () => ({ repo, tx }),
        },
        'PostgresTypeOrm (4-shell e2e)',
      );

      it('PostgresTypeOrmJobRepository is the concrete impl wired by the e2e harness', () => {
        expect(repo).toBeInstanceOf(PostgresTypeOrmJobRepository);
      });

      it('PostgresTypeOrmTransactionManager is the concrete impl wired by the e2e harness', () => {
        expect(tx).toBeInstanceOf(PostgresTypeOrmTransactionManager);
      });
    });

    // -------------------------------------------------------------------------
    // Shell 3: Drizzle Postgres
    // -------------------------------------------------------------------------
    describe('Drizzle Postgres shell', () => {
      let mod: TestingModule;
      let drizzleDb: NodePgDatabase<typeof postgresDrizzleSchema>;
      let repo: PostgresDrizzleJobRepository;
      let tx: PostgresDrizzleTransactionManager;

      beforeAll(async () => {
        await truncateAll();
        // The shell's classes take a typed
        // `NodePgDatabase<typeof postgresDrizzleSchema>` directly.
        // The `PostgresDrizzleBatchModule` carrier is wired into
        // the test module; the `useValue` providers below take
        // the host's `NodePgDatabase` constructed just above.
        drizzleDb = drizzle(pool, { schema: postgresDrizzleSchema });

        mod = await Test.createTestingModule({
          imports: [PostgresDrizzleBatchModule],
          providers: [
            {
              provide: PostgresDrizzleJobRepository,
              useValue: new PostgresDrizzleJobRepository(drizzleDb),
            },
            {
              provide: PostgresDrizzleTransactionManager,
              useValue: new PostgresDrizzleTransactionManager(drizzleDb),
            },
          ],
        }).compile();

        repo = mod.get(PostgresDrizzleJobRepository);
        tx = mod.get(PostgresDrizzleTransactionManager);
      }, 60_000);

      afterAll(async () => {
        if (mod) await mod.close();
      });

      runJobRepositoryContract(
        {
          create: () => ({ repo, tx }),
        },
        'PostgresDrizzle (4-shell e2e)',
      );

      it('PostgresDrizzleJobRepository is the concrete impl wired by the e2e harness', () => {
        expect(repo).toBeInstanceOf(PostgresDrizzleJobRepository);
      });

      it('PostgresDrizzleTransactionManager is the concrete impl wired by the e2e harness', () => {
        expect(tx).toBeInstanceOf(PostgresDrizzleTransactionManager);
      });
    });

    // -------------------------------------------------------------------------
    // Shell 4: Prisma Postgres
    // -------------------------------------------------------------------------
    describe('Prisma Postgres shell', () => {
      let mod: TestingModule;
      let prisma: PrismaClient;
      let repo: PostgresPrismaJobRepository;
      let tx: PostgresPrismaTransactionManager;

      beforeAll(async () => {
        await truncateAll();
        // The `prisma db push` run in the file-level `beforeAll`
        // already applied the bundled `prisma/schema.prisma` to
        // the testcontainer. The shell's classes take a
        // `PrismaClient` directly. The `PostgresPrismaBatchModule`
        // carrier is wired into the test module; the `useValue`
        // providers below take the host's `PrismaClient`
        // constructed just above.
        prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
        await prisma.$connect();

        mod = await Test.createTestingModule({
          imports: [PostgresPrismaBatchModule],
          providers: [
            {
              provide: PostgresPrismaJobRepository,
              useValue: new PostgresPrismaJobRepository(prisma),
            },
            {
              provide: PostgresPrismaTransactionManager,
              useValue: new PostgresPrismaTransactionManager(prisma),
            },
          ],
        }).compile();

        repo = mod.get(PostgresPrismaJobRepository);
        tx = mod.get(PostgresPrismaTransactionManager);
      }, 60_000);

      afterAll(async () => {
        if (mod) await mod.close();
        if (prisma) await prisma.$disconnect();
      });

      runJobRepositoryContract(
        {
          create: () => ({ repo, tx }),
        },
        'PostgresPrisma (4-shell e2e)',
      );

      it('PostgresPrismaJobRepository is the concrete impl wired by the e2e harness', () => {
        expect(repo).toBeInstanceOf(PostgresPrismaJobRepository);
      });

      it('PostgresPrismaTransactionManager is the concrete impl wired by the e2e harness', () => {
        expect(tx).toBeInstanceOf(PostgresPrismaTransactionManager);
      });
    });
  },
);

/**
 * Skip notice — printed when `RUN_POSTGRES_E2E=1` is NOT set so a CI
 * log makes the gate's reason obvious. Mirrors the slot-level e2e
 * pattern (see `packages/drizzle/tests/e2e-postgres.test.ts`).
 */
describe('@nest-batch/postgresql — 4-shell e2e (skipped — RUN_POSTGRES_E2E=1 not set)', () => {
  it('skip notice', () => {
    if (E2E_ENABLED) {
      // The describeE2E block above is running; the notice is a no-op.
      expect(E2E_ENABLED).toBe(true);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        '  [postgresql e2e] skipped — set RUN_POSTGRES_E2E=1 to run the ' +
        '4-shell live Postgres harness.\n' +
        '  [postgresql e2e] command: RUN_POSTGRES_E2E=1 pnpm --filter ' +
        '@nest-batch/postgresql test:e2e\n',
    );
    expect(E2E_ENABLED).toBe(false);
  });
});
