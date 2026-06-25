import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { PostgresPrismaJobRepository } from './postgres-prisma-job-repository';
import { PostgresPrismaTransactionManager } from './postgres-prisma-transaction-manager';
import { PostgresPrismaBatchModule } from './postgres-prisma.module';

/**
 * `PostgresPrismaAdapter` — the PostgreSQL driver shell for the
 * `@nest-batch/prisma` adapter slot.
 *
 * This shell pairs the host-owned `PrismaClient` with the
 * PostgreSQL repository / transaction-manager implementations. The
 * consuming app owns the Prisma schema, generated client, and
 * migration files.
 *
 * The host owns the `PrismaClient` instance — the shell does **not**
 * call `prisma generate` or instantiate the client.
 */
export class PostgresPrismaAdapter {
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
      name: 'postgres-prisma',
      module: {
        module: PostgresPrismaBatchModule,
        global: true,
        providers: [
          PostgresPrismaJobRepository,
          PostgresPrismaTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: PostgresPrismaJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: PostgresPrismaTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: PostgresPrismaJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: PostgresPrismaTransactionManager,
        },
      ],
    };
  }
}
