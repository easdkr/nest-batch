import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { MysqlTypeOrmJobRepository } from './mysql-typeorm-job-repository';
import { MysqlTypeOrmTransactionManager } from './mysql-typeorm-transaction-manager';
import { MysqlTypeOrmBatchModule } from './mysql-typeorm.module';

/**
 * `MysqlTypeOrmAdapter` — the MySQL driver shell for the
 * `@nest-batch/typeorm` adapter slot.
 *
 * This shell pairs the driver-agnostic `TypeOrmJobRepository` /
 * `TypeOrmTransactionManager` shapes (owned by `@nest-batch/typeorm`)
 * with the MySQL-specific `DataSource` (from `typeorm@^1.0.0` over
 * the `mysql2` driver). It does **not** call `TypeOrmModule.forRoot()`
 * — the host must call it in `AppModule.imports` (with the MySQL
 * connection options and the 6 batch meta-entities spread into the
 * `entities` array).
 */
export class MysqlTypeOrmAdapter {
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
      name: 'mysql-typeorm',
      module: {
        module: MysqlTypeOrmBatchModule,
        global: true,
        providers: [
          MysqlTypeOrmJobRepository,
          MysqlTypeOrmTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MysqlTypeOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MysqlTypeOrmTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: MysqlTypeOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MysqlTypeOrmTransactionManager,
        },
      ],
    };
  }
}
