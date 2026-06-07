/**
 * F3 Real Manual QA — Edge case coverage for the slim
 * `MikroOrmAdapter` refactor.
 *
 * Two scenarios the plan called out specifically:
 *
 *   1. `MikroOrmAdapter.forRoot()` called inside a `forRootAsync`
 *      `useFactory` (verify it works as a value — i.e. the
 *      factory can return a `BatchAdapter` produced by the
 *      adapter's no-arg factory and `NestBatchModule` accepts
 *      it through the async path).
 *
 *   2. `MikroOrmModule.forRoot({...})` (default scope) — the
 *      README/MIGRATION.md supported case. The host-owned
 *      `MikroOrmModule.forRoot()` must register `MikroORM` and
 *      `EntityManager` in a way that the adapter's
 *      `MikroORMJobRepository` can inject through the module
 *      boundary.
 *
 * Both tests boot a real `TestingModule` against the live
 * PostgreSQL container, so they only run when the docker
 * `nest-batch-postgres` instance is up on 5434.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver, type SqlEntityManager } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  EXECUTION_STRATEGY,
  JobLauncher,
  NestBatchModule,
  type BatchAdaptersConfig,
  type IExecutionStrategy,
  JobStatus,
} from '@nest-batch/core';
import { MikroOrmAdapter } from '../src/adapters/mikro-orm.adapter';
import { MikroORMJobRepository } from '../src/mikroorm-job-repository';
import { BATCH_META_ENTITIES } from '../src/entities/job-meta.entities';

const PG_CONFIG = {
  host: process.env.DATABASE_HOST ?? '127.0.0.1',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  user: process.env.DATABASE_USER ?? 'demo',
  password: process.env.DATABASE_PASSWORD ?? 'demo',
  dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
};

const TRUNCATE_SQL = `
  TRUNCATE TABLE batch_step_execution_context,
                   batch_job_execution_context,
                   batch_step_execution,
                   batch_job_execution_params,
                   batch_job_execution,
                   batch_job_instance
  RESTART IDENTITY CASCADE
`;

const stubStrategy: IExecutionStrategy = {
  name: 'stub',
  launch: async () => ({ kind: 'completed' as const, status: JobStatus.COMPLETED }),
};

describe('F3 Edge case: MikroOrmAdapter.forRoot() in forRootAsync useFactory', () => {
  test('forRootAsync useFactory returns a BatchAdaptersConfig built by MikroOrmAdapter.forRoot()', async () => {
    let moduleRef: TestingModule | undefined;
    try {
      moduleRef = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot({
            ...PG_CONFIG,
            driver: PostgreSqlDriver,
            entities: [...BATCH_META_ENTITIES],
          }),
          NestBatchModule.forRootAsync({
            useFactory: (): BatchAdaptersConfig => ({
              persistence: MikroOrmAdapter.forRoot(),
              transport: {
                name: 'stub',
                module: { module: class StubTransportModule {} },
                globalProviders: [
                  { provide: EXECUTION_STRATEGY, useValue: stubStrategy },
                ],
              },
            }),
          }),
        ],
      }).compile();

      await moduleRef.init();
      const launcher = moduleRef.get(JobLauncher);
      expect(launcher).toBeDefined();
    } finally {
      await moduleRef?.close();
    }
  });
});

describe('F3 Edge case: MikroOrmModule.forRoot() default — adapter resolves EntityManager', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      ...PG_CONFIG,
      entities: [...BATCH_META_ENTITIES],
    });
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  test('default-scope MikroOrmModule.forRoot() + slim MikroOrmAdapter.forRoot() — adapter gets EntityManager', async () => {
    const forkedEm = orm.em.fork() as unknown as SqlEntityManager;
    await forkedEm.execute(TRUNCATE_SQL);

    let moduleRef: TestingModule | undefined;
    try {
      moduleRef = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot({
            ...PG_CONFIG,
            driver: PostgreSqlDriver,
            entities: [...BATCH_META_ENTITIES],
          }),
          NestBatchModule.forRoot({
            adapters: {
              persistence: MikroOrmAdapter.forRoot(),
              transport: {
                name: 'stub',
                module: { module: class StubTransportModule {} },
                globalProviders: [
                  { provide: EXECUTION_STRATEGY, useValue: stubStrategy },
                ],
              },
            },
          }),
        ],
      }).compile();

      await moduleRef.init();

      const repo = moduleRef.get(MikroORMJobRepository);
      expect(repo).toBeDefined();
      const repoEm: EntityManager = (repo as unknown as { em: EntityManager }).em;
      expect(repoEm).toBeDefined();
      expect(typeof repoEm.getConnection).toBe('function');
    } finally {
      await moduleRef?.close();
    }
  });
});
