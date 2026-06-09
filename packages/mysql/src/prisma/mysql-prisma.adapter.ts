import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { MysqlPrismaJobRepository } from './mysql-prisma-job-repository';
import { MysqlPrismaTransactionManager } from './mysql-prisma-transaction-manager';
import { MysqlPrismaBatchModule } from './mysql-prisma.module';

/**
 * `MysqlPrismaAdapter` — the MySQL driver shell for the
 * `@nest-batch/prisma` adapter slot.
 *
 * This shell pairs the driver-agnostic `PrismaClient` shape (owned by
 * `@nest-batch/prisma`) with the MySQL provider configuration
 * (the `provider = "mysql"` schema bundled in this package's
 * `prisma/schema.prisma`).
 *
 * The host owns the `PrismaClient` instance — the shell does **not**
 * call `prisma generate` or instantiate the client.
 */
export class MysqlPrismaAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `PrismaClient` lifecycle. The adapter only needs to
   * declare its own provider / export / `globalProviders` surface.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'mysql-prisma',
      module: {
        module: MysqlPrismaBatchModule,
        global: true,
        providers: [
          MysqlPrismaJobRepository,
          MysqlPrismaTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MysqlPrismaJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MysqlPrismaTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: MysqlPrismaJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MysqlPrismaTransactionManager,
        },
      ],
    };
  }
}
