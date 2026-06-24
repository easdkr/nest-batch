import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';
import { MikroOrmDriverProvider } from '@nest-batch/mikro-orm';

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
   * surface. The host still owns `MikroOrmModule.forRoot(...)`; this
   * shell only aliases the host `EntityManager` to the batch driver
   * token.
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
            provide: MikroOrmDriverProvider,
            useExisting: EntityManager,
          },
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MysqlMikroOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MysqlMikroOrmTransactionManager,
          },
        ],
        exports: [MikroOrmDriverProvider, JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        {
          provide: MikroOrmDriverProvider,
          useExisting: EntityManager,
        },
        { provide: JOB_REPOSITORY_TOKEN, useClass: MysqlMikroOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MysqlMikroOrmTransactionManager,
        },
      ],
    };
  }
}
