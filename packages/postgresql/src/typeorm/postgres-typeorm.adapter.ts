import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { PostgresTypeOrmJobRepository } from './postgres-typeorm-job-repository';
import { PostgresTypeOrmTransactionManager } from './postgres-typeorm-transaction-manager';
import { PostgresTypeOrmBatchModule } from './postgres-typeorm.module';

/**
 * `PostgresTypeOrmAdapter` — the PostgreSQL driver shell for the
 * `@nest-batch/typeorm` adapter slot.
 *
 * This shell pairs the driver-agnostic `TypeOrmJobRepository` /
 * `TypeOrmTransactionManager` shapes (owned by `@nest-batch/typeorm`)
 * with the Postgres-specific `DataSource` (from `typeorm@^1.0.0` over
 * the `pg` driver). It does **not** call `TypeOrmModule.forRoot()`
 * — the host must call it in `AppModule.imports` (with the Postgres
 * connection options and the 6 batch meta-entities spread into the
 * `entities` array).
 *
 * T-AC-2b boundary: this shell lives in `@nest-batch/postgresql` —
 * NOT in `@nest-batch/typeorm`. The slot package stays
 * driver-agnostic; the Postgres-specific `pg` driver binding lives
 * here. The boundary test in
 * `packages/postgresql/tests/boundary/no-forbidden-imports.test.ts`
 * enforces the inverse — it would fail if `@nest-batch/typeorm`
 * ever picked up a `pg` import.
 */
export class PostgresTypeOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `TypeOrmModule.forRoot(...)` call. The adapter only
   * needs to declare its own provider / export / `globalProviders`
   * surface; the `DataSource` itself is the host's
   * responsibility.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'postgres-typeorm',
      module: {
        module: PostgresTypeOrmBatchModule,
        global: true,
        providers: [
          PostgresTypeOrmJobRepository,
          PostgresTypeOrmTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: PostgresTypeOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: PostgresTypeOrmTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: PostgresTypeOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: PostgresTypeOrmTransactionManager,
        },
      ],
    };
  }
}
