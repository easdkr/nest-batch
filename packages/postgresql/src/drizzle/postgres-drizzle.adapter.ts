import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { PostgresDrizzleJobRepository } from './postgres-drizzle-job-repository';
import { PostgresDrizzleTransactionManager } from './postgres-drizzle-transaction-manager';
import { PostgresDrizzleBatchModule } from './postgres-drizzle.module';

/**
 * `PostgresDrizzleAdapter` — the PostgreSQL driver shell for the
 * `@nest-batch/drizzle` adapter slot.
 *
 * This shell pairs the driver-agnostic Drizzle slot
 * (`@nest-batch/drizzle`'s `DrizzleAdapter`) with the **Postgres**
 * table shape (`pgTable` from `drizzle-orm/pg-core`). The host
 * wires a `NodePgDatabase` (from `drizzle-orm/node-postgres`)
 * into the `DrizzleAdapter` flow via
 * `PostgresDrizzleAdapter.forRoot()`.
 *
 * The shell does **not** call `drizzle()` — the host must create
 * the `NodePgDatabase` in their own providers and pass the
 * Postgres connection (typically a `pg` `Pool`).
 *
 * Boundary: this shell lives in `@nest-batch/postgresql`, so the
 * Postgres-specific imports (`drizzle-orm/node-postgres` /
 * `drizzle-orm/pg-core`) are owned here. The
 * `@nest-batch/drizzle` slot package stays driver-agnostic.
 */
export class PostgresDrizzleAdapter {
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
      name: 'postgres-drizzle',
      module: {
        module: PostgresDrizzleBatchModule,
        global: true,
        providers: [
          PostgresDrizzleJobRepository,
          PostgresDrizzleTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: PostgresDrizzleJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: PostgresDrizzleTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: PostgresDrizzleJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: PostgresDrizzleTransactionManager,
        },
      ],
    };
  }
}
