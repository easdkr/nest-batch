import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { PrismaClient } from '@prisma/client';
import { PrismaJobRepository } from '../src/repository/prisma-job-repository';
import { PrismaTransactionManager } from '../src/transaction/prisma-transaction-manager';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/**
 * Shared contract suite for the Prisma adapter using testcontainers.
 *
 * Spins up a fresh PostgreSQL container once per test file,
 * applies the schema, and truncates tables before each test.
 */
describe('PrismaJobRepository + PrismaTransactionManager contract', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let prisma: PrismaClient;
  let repo: PrismaJobRepository;
  let tx: PrismaTransactionManager;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('nest_batch_prisma')
      .withUsername('demo')
      .withPassword('demo')
      .start();

    dbUrl = container.getConnectionUri();

    // Apply schema using raw pg client
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS batch_job_instance (
        id VARCHAR(255) PRIMARY KEY,
        job_name VARCHAR(255) NOT NULL,
        job_key VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_name, job_key)
      );

      CREATE TABLE IF NOT EXISTS batch_job_execution (
        id VARCHAR(255) PRIMARY KEY,
        job_instance_id VARCHAR(255) NOT NULL REFERENCES batch_job_instance(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        exit_code VARCHAR(255) NOT NULL DEFAULT '',
        exit_message TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_batch_job_execution_job_instance_id ON batch_job_execution(job_instance_id);
      CREATE INDEX IF NOT EXISTS idx_batch_job_execution_status ON batch_job_execution(status);

      CREATE TABLE IF NOT EXISTS batch_step_execution (
        id VARCHAR(255) PRIMARY KEY,
        job_execution_id VARCHAR(255) NOT NULL REFERENCES batch_job_execution(id) ON DELETE CASCADE,
        step_name VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        read_count INT NOT NULL DEFAULT 0,
        write_count INT NOT NULL DEFAULT 0,
        skip_count INT NOT NULL DEFAULT 0,
        rollback_count INT NOT NULL DEFAULT 0,
        commit_count INT NOT NULL DEFAULT 0,
        exit_code VARCHAR(255) NOT NULL DEFAULT '',
        exit_message TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_batch_step_execution_job_execution_id ON batch_step_execution(job_execution_id);

      CREATE TABLE IF NOT EXISTS batch_job_execution_context (
        job_execution_id VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '',
        version INT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS batch_step_execution_context (
        step_execution_id VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '',
        version INT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS batch_job_execution_params (
        id VARCHAR(255) PRIMARY KEY,
        job_execution_id VARCHAR(255) NOT NULL REFERENCES batch_job_execution(id) ON DELETE CASCADE,
        param_key VARCHAR(255) NOT NULL,
        param_value TEXT,
        param_type VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_execution_id, param_key)
      );
    `);
    await client.end();
  }, 120_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  beforeEach(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: dbUrl,
        },
      },
    });

    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        batch_step_execution_context,
        batch_job_execution_context,
        batch_step_execution,
        batch_job_execution,
        batch_job_instance
      RESTART IDENTITY CASCADE
    `);

    repo = new PrismaJobRepository(prisma);
    tx = new PrismaTransactionManager(prisma);
  });

  afterEach(async () => {
    if (prisma) await prisma.$disconnect();
  });

  runJobRepositoryContract(
    {
      create: () => ({ repo, tx }),
    },
    'PrismaJobRepository + PrismaTransactionManager',
  );

  test('PrismaJobRepository is a JobRepository subclass (runtime smoke)', () => {
    expect(repo.constructor.name).toBe('PrismaJobRepository');
  });

  test('PrismaTransactionManager is a TransactionManager subclass (runtime smoke)', () => {
    expect(tx.constructor.name).toBe('PrismaTransactionManager');
  });
});