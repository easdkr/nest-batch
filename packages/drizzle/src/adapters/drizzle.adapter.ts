import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { DrizzleJobRepository } from '../repository/drizzle-job-repository';
import { DrizzleTransactionManager } from '../transaction/drizzle-transaction-manager';
import { DrizzleBatchModule } from '../drizzle.module';

/**
 * `DrizzleAdapter` — the Drizzle ORM persistence adapter for
 * `@nest-batch/core`.
 *
 * It owns the `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 * bindings to the Drizzle-backed `DrizzleJobRepository` /
 * `DrizzleTransactionManager` implementations. This adapter does
 * not bootstrap Drizzle ORM — the host must provide the
 * `NodePgDatabase` instance in their own providers.
 */
export class DrizzleAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the Drizzle ORM setup. The adapter only needs to declare its
   * own provider / export / `globalProviders` surface.
   *
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` exposing `JOB_REPOSITORY_TOKEN` and
   *   `TRANSACTION_MANAGER_TOKEN` to the host application.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'drizzle',
      module: {
        module: DrizzleBatchModule,
        global: true,
        providers: [
          DrizzleJobRepository,
          DrizzleTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: DrizzleJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: DrizzleTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: DrizzleJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: DrizzleTransactionManager,
        },
      ],
    };
  }
}
