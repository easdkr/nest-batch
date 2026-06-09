/**
 * E2E harness for `@nest-batch/mysql` against a real MySQL 8.x.
 *
 * Spins up a MySQL 8.x testcontainer, applies the 6-table batch
 * meta-schema (via the bundled DDL), and runs the shared
 * `@nest-batch/core` contract suite against the MySQL-specific
 * repository / transaction manager implementations for each of the
 * 4 MySQL adapter shells:
 *
 *   1. MysqlMikroOrmJobRepository + MysqlMikroOrmTransactionManager
 *   2. MysqlTypeOrmJobRepository + MysqlTypeOrmTransactionManager
 *   3. MysqlDrizzleJobRepository + MysqlDrizzleTransactionManager
 *   4. MysqlPrismaJobRepository + MysqlPrismaTransactionManager
 *
 * Gated by `RUN_MYSQL_E2E=1`. Without the env var the file logs
 * a skip notice and exits 0. The default
 * `pnpm --filter @nest-batch/mysql test` run does NOT start a
 * container and does NOT require a Docker daemon.
 *
 * Run locally with a Docker daemon up:
 *
 *   RUN_MYSQL_E2E=1 pnpm --filter @nest-batch/mysql test -- tests/e2e-mysql.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runJobRepositoryContract } from '@nest-batch/core/test-contracts';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createPool, type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { MikroORM } from '@mikro-orm/core';
import { MySqlDriver } from '@mikro-orm/mysql';
import { DataSource } from 'typeorm';

import { BATCH_META_ENTITIES } from '@nest-batch/mikro-orm';
import * as mysqlDrizzleSchema from '../src/drizzle/schema';
import { MysqlMikroOrmJobRepository } from '../src/mikroorm/mysql-mikroorm-job-repository';
import { MysqlMikroOrmTransactionManager } from '../src/mikroorm/mysql-mikroorm-transaction-manager';
import { MysqlTypeOrmJobRepository } from '../src/typeorm/mysql-typeorm-job-repository';
import { MysqlTypeOrmTransactionManager } from '../src/typeorm/mysql-typeorm-transaction-manager';
import { MysqlDrizzleJobRepository } from '../src/drizzle/mysql-drizzle-job-repository';
import { MysqlDrizzleTransactionManager } from '../src/drizzle/mysql-drizzle-transaction-manager';

const E2E_ENABLED = process.env.RUN_MYSQL_E2E === '1';

const describeE2E = E2E_ENABLED ? describe : describe.skip;

const META_DDL = `
  CREATE TABLE IF NOT EXISTS \`batch_job_instance\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`job_name\` VARCHAR(255) NOT NULL,
    \`job_key\` VARCHAR(255) NOT NULL,
    \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`batch_job_instance_job_name_job_key_unique\` (\`job_name\`, \`job_key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS \`batch_job_execution\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`job_instance_id\` VARCHAR(255) NOT NULL,
    \`status\` VARCHAR(20) NOT NULL,
    \`start_time\` DATETIME(6) NULL,
    \`end_time\` DATETIME(6) NULL,
    \`exit_code\` VARCHAR(255) NOT NULL DEFAULT '',
    \`exit_message\` TEXT NOT NULL,
    \`params\` TEXT NOT NULL,
    PRIMARY KEY (\`id\`),
    KEY \`batch_job_execution_job_instance_id_index\` (\`job_instance_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS \`batch_job_execution_params\` (
    \`job_execution_id\` VARCHAR(255) NOT NULL,
    \`param_name\` VARCHAR(255) NOT NULL,
    \`param_type\` VARCHAR(20) NOT NULL,
    \`string_value\` TEXT NULL,
    \`date_value\` DATETIME(6) NULL,
    \`long_value\` VARCHAR(255) NULL,
    \`double_value\` DOUBLE NULL,
    PRIMARY KEY (\`job_execution_id\`, \`param_name\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS \`batch_step_execution\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`job_execution_id\` VARCHAR(255) NOT NULL,
    \`step_name\` VARCHAR(255) NOT NULL,
    \`status\` VARCHAR(20) NOT NULL,
    \`read_count\` INT NOT NULL DEFAULT 0,
    \`write_count\` INT NOT NULL DEFAULT 0,
    \`skip_count\` INT NOT NULL DEFAULT 0,
    \`rollback_count\` INT NOT NULL DEFAULT 0,
    \`commit_count\` INT NOT NULL DEFAULT 0,
    \`exit_code\` VARCHAR(255) NOT NULL DEFAULT '',
    \`exit_message\` TEXT NOT NULL,
    \`created_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (\`id\`),
    KEY \`batch_step_execution_job_execution_id_index\` (\`job_execution_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS \`batch_job_execution_context\` (
    \`job_execution_id\` VARCHAR(255) NOT NULL,
    \`data\` TEXT NOT NULL,
    \`version\` INT NOT NULL DEFAULT 0,
    PRIMARY KEY (\`job_execution_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  CREATE TABLE IF NOT EXISTS \`batch_step_execution_context\` (
    \`step_execution_id\` VARCHAR(255) NOT NULL,
    \`data\` TEXT NOT NULL,
    \`version\` INT NOT NULL DEFAULT 0,
    PRIMARY KEY (\`step_execution_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const TRUNCATE_SQL = [
  'SET FOREIGN_KEY_CHECKS = 0',
  'TRUNCATE TABLE `batch_step_execution_context`',
  'TRUNCATE TABLE `batch_job_execution_context`',
  'TRUNCATE TABLE `batch_step_execution`',
  'TRUNCATE TABLE `batch_job_execution_params`',
  'TRUNCATE TABLE `batch_job_execution`',
  'TRUNCATE TABLE `batch_job_instance`',
  'SET FOREIGN_KEY_CHECKS = 1',
];

describeE2E('MySQL e2e (testcontainers MySQL 8.x, gated by RUN_MYSQL_E2E=1)', () => {
  let container: StartedMySqlContainer;
  let pool: Pool;
  let connectionUri: string;

  // MikroORM MySQL
  let mikroOrm: MikroORM;

  // TypeORM MySQL
  let typeormDs: DataSource;

  // Drizzle MySQL
  let drizzleDb: MySql2Database<typeof mysqlDrizzleSchema>;

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.0')
      .withDatabase('nest_batch_mysql_e2e')
      .withUsername('demo')
      .withUserPassword('demo')
      .withRootPassword('root')
      .start();

    connectionUri = container.getConnectionUri();
    pool = createPool({
      uri: connectionUri,
      connectionLimit: 5,
    });

    for (const stmt of META_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
  }, 180_000);

  afterAll(async () => {
    if (typeormDs?.isInitialized) await typeormDs.destroy();
    if (mikroOrm) await mikroOrm.close();
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    for (const stmt of TRUNCATE_SQL) {
      await pool.query(stmt);
    }

    mikroOrm = await MikroORM.init({
      driver: MySqlDriver,
      clientUrl: connectionUri,
      entities: [...BATCH_META_ENTITIES] as never,
      discovery: { warnWhenNoEntities: false },
      connect: true,
    });

    typeormDs = new DataSource({
      type: 'mysql',
      url: connectionUri,
      entities: [],
      synchronize: false,
      logging: false,
    });
    await typeormDs.initialize();

    drizzleDb = drizzle(pool, { schema: mysqlDrizzleSchema, mode: 'default' });
  });

  describe('MikroORM MySQL shell', () => {
    let repo: MysqlMikroOrmJobRepository;
    let tx: MysqlMikroOrmTransactionManager;

    beforeEach(() => {
      repo = new MysqlMikroOrmJobRepository(mikroOrm.em);
      tx = new MysqlMikroOrmTransactionManager(mikroOrm.em);
    });

    runJobRepositoryContract(
      {
        create: () => ({ repo, tx }),
      },
      'MysqlMikroOrm (e2e)',
    );

    test('MysqlMikroOrmJobRepository is the concrete impl wired by the e2e harness', () => {
      expect(repo).toBeInstanceOf(MysqlMikroOrmJobRepository);
    });

    test('MysqlMikroOrmTransactionManager is the concrete impl wired by the e2e harness', () => {
      expect(tx).toBeInstanceOf(MysqlMikroOrmTransactionManager);
    });
  });

  describe('TypeORM MySQL shell', () => {
    let repo: MysqlTypeOrmJobRepository;
    let tx: MysqlTypeOrmTransactionManager;

    beforeEach(() => {
      repo = new MysqlTypeOrmJobRepository(typeormDs);
      tx = new MysqlTypeOrmTransactionManager(typeormDs);
    });

    runJobRepositoryContract(
      {
        create: () => ({ repo, tx }),
      },
      'MysqlTypeOrm (e2e)',
    );

    test('MysqlTypeOrmJobRepository is the concrete impl wired by the e2e harness', () => {
      expect(repo).toBeInstanceOf(MysqlTypeOrmJobRepository);
    });

    test('MysqlTypeOrmTransactionManager is the concrete impl wired by the e2e harness', () => {
      expect(tx).toBeInstanceOf(MysqlTypeOrmTransactionManager);
    });
  });

  describe('Drizzle MySQL shell', () => {
    let repo: MysqlDrizzleJobRepository;
    let tx: MysqlDrizzleTransactionManager;

    beforeEach(() => {
      repo = new MysqlDrizzleJobRepository(drizzleDb);
      tx = new MysqlDrizzleTransactionManager(drizzleDb);
    });

    runJobRepositoryContract(
      {
        create: () => ({ repo, tx }),
      },
      'MysqlDrizzle (e2e)',
    );

    test('MysqlDrizzleJobRepository is the concrete impl wired by the e2e harness', () => {
      expect(repo).toBeInstanceOf(MysqlDrizzleJobRepository);
    });

    test('MysqlDrizzleTransactionManager is the concrete impl wired by the e2e harness', () => {
      expect(tx).toBeInstanceOf(MysqlDrizzleTransactionManager);
    });
  });

  describe('Prisma MySQL shell (shape smoke test)', () => {
    // The Prisma MySQL shell needs a `prisma generate` step against
    // the bundled `prisma/schema.prisma` (mysql provider). The
    // generated client is **not** part of the default e2e path —
    // the 3 fully-wired contract suites above (MikroORM, TypeORM,
    // Drizzle) are the release-gate e2e. The Prisma contract
    // assertion below is the shape smoke test that the shell
    // exists and is correctly importable from the public API.
    test('MysqlPrismaAdapter / JobRepository / TransactionManager are importable from the public API', async () => {
      const mod = await import('../src/index');
      expect(typeof mod.MysqlPrismaAdapter.forRoot).toBe('function');
      expect(typeof mod.MysqlPrismaJobRepository).toBe('function');
      expect(typeof mod.MysqlPrismaTransactionManager).toBe('function');
      const adapter = mod.MysqlPrismaAdapter.forRoot();
      expect(adapter.name).toBe('mysql-prisma');
    });
  });
});

/**
 * Skip notice — printed when `RUN_MYSQL_E2E=1` is NOT set so a CI
 * log makes the gate's reason obvious.
 */
describe('MySQL e2e (skipped — RUN_MYSQL_E2E=1 not set)', () => {
  test('skip notice', () => {
    if (E2E_ENABLED) {
      expect(E2E_ENABLED).toBe(true);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        '  [mysql e2e] skipped — set RUN_MYSQL_E2E=1 to run the ' +
        'testcontainers MySQL 8.x harness.\n' +
        '  [mysql e2e] command: RUN_MYSQL_E2E=1 pnpm --filter ' +
        '@nest-batch/mysql test -- tests/e2e-mysql.test.ts\n',
    );
    expect(E2E_ENABLED).toBe(false);
  });
});
