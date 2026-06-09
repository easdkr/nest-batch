import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { MysqlMikroOrmJobRepository } from './mysql-mikroorm-job-repository';
import { MysqlMikroOrmTransactionManager } from './mysql-mikroorm-transaction-manager';
import { MysqlMikroOrmBatchModule } from './mysql-mikroorm.module';

/**
 * `MysqlMikroOrmAdapter` — the MySQL driver shell for the
 * `@nest-batch/mikro-orm` adapter slot.
 *
 * This shell pairs the driver-agnostic `MikroORMJobRepository` /
 * `MikroORMTransactionManager` shapes (owned by `@nest-batch/mikro-orm`)
 * with the MySQL-specific `EntityManager` (from `@mikro-orm/mysql`).
 * It does **not** call `MikroOrmModule.forRoot()` — the host must call
 * it in `AppModule.imports` (with the MySQL connection options and the
 * 6 batch meta-entities spread into the `entities` array).
 */
export class MysqlMikroOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `MikroOrmModule.forRoot(...)` call. The adapter only
   * needs to declare its own provider / export / `globalProviders`
   * surface; the `EntityManager` itself is the host's
   * responsibility.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'mysql-mikro-orm',
      module: {
        module: MysqlMikroOrmBatchModule,
        global: true,
        providers: [
          MysqlMikroOrmJobRepository,
          MysqlMikroOrmTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MysqlMikroOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MysqlMikroOrmTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: MysqlMikroOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MysqlMikroOrmTransactionManager,
        },
      ],
    };
  }
}
