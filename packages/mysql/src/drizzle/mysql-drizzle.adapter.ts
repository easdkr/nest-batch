import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { MysqlDrizzleJobRepository } from './mysql-drizzle-job-repository';
import { MysqlDrizzleTransactionManager } from './mysql-drizzle-transaction-manager';
import { MysqlDrizzleBatchModule } from './mysql-drizzle.module';

/**
 * `MysqlDrizzleAdapter` — the MySQL driver shell for the
 * `@nest-batch/drizzle` adapter slot.
 *
 * This shell pairs the driver-agnostic Drizzle `pgTable` schema
 * (owned by `@nest-batch/drizzle`) — but with the **MySQL** table
 * shape (`mysqlTable` from `drizzle-orm/mysql-core`). The host
 * wires a `MySql2Database` (from `drizzle-orm/mysql2`) into the
 * `DrizzleAdapter` flow via `MysqlDrizzleAdapter.forRoot()`.
 *
 * The shell does **not** call `drizzle()` — the host must create
 * the `MySql2Database` in their own providers and pass the
 * MySQL connection (typically a `mysql2/promise` pool).
 */
export class MysqlDrizzleAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the Drizzle setup. The adapter only needs to declare its
   * own provider / export / `globalProviders` surface.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'mysql-drizzle',
      module: {
        module: MysqlDrizzleBatchModule,
        global: true,
        providers: [
          MysqlDrizzleJobRepository,
          MysqlDrizzleTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MysqlDrizzleJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MysqlDrizzleTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: MysqlDrizzleJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MysqlDrizzleTransactionManager,
        },
      ],
    };
  }
}
