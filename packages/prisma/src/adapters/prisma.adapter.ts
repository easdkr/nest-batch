import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { PrismaJobRepository } from '../repository/prisma-job-repository';
import { PrismaTransactionManager } from '../transaction/prisma-transaction-manager';
import { PrismaBatchModule } from '../prisma.module';

/**
 * `PrismaAdapter` — the Prisma persistence adapter for
 * `@nest-batch/core`.
 *
 * It owns the `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 * bindings to the Prisma-backed `PrismaJobRepository` /
 * `PrismaTransactionManager` implementations. This adapter does
 * not call `PrismaModule.forRoot()` — the host must call it in
 * `AppModule.imports` (and register the batch meta schema via
 * Prisma migrations).
 */
export class PrismaAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `PrismaModule.forRoot(...)` call. The adapter only needs
   * to declare its own provider / export / `globalProviders`
   * surface; the `PrismaClient` itself is the host's responsibility.
   *
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` exposing `JOB_REPOSITORY_TOKEN` and
   *   `TRANSACTION_MANAGER_TOKEN` to the host application.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'prisma',
      module: {
        module: PrismaBatchModule,
        global: true,
        providers: [
          PrismaJobRepository,
          PrismaTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: PrismaJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: PrismaTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: PrismaJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: PrismaTransactionManager,
        },
      ],
    };
  }
}
