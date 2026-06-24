import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';
import { MikroOrmDriverProvider } from '@nest-batch/mikro-orm';

import { PostgresMikroOrmJobRepository } from './postgres-mikroorm-job-repository';
import { PostgresMikroOrmTransactionManager } from './postgres-mikroorm-transaction-manager';
import { PostgresMikroOrmBatchModule } from './postgres-mikroorm.module';

/**
 * `PostgresMikroOrmAdapter` — the PostgreSQL driver shell for the
 * `@nest-batch/mikro-orm` adapter slot.
 *
 * This shell pairs the driver-agnostic `MikroORMJobRepository` /
 * `MikroORMTransactionManager` shapes (owned by `@nest-batch/mikro-orm`)
 * with the Postgres-specific `EntityManager` (from
 * `@mikro-orm/postgresql`). It does **not** call
 * `MikroOrmModule.forRoot()` — the host must call it in
 * `AppModule.imports` (with the Postgres connection options and the
 * 5 batch meta-entities from `@nest-batch/mikro-orm`'s
 * `BATCH_META_ENTITIES` spread into the `entities` array).
 *
 * The shell is a thin carrier: the repository / transaction-manager
 * implementations are driver-agnostic, so this file re-exports
 * `@nest-batch/mikro-orm`'s `MikroORMJobRepository` as
 * `PostgresMikroOrmJobRepository` and only adds a `PostgresEntityManager`-
 * typed wrapper around the transaction manager. The
 * `MikroOrmDriverProvider` token (`Symbol.for('@nest-batch/mikro-orm/MikroOrmDriverProvider')`)
 * is aliased here to the host `EntityManager`; the slot's repository
 * class injects that token via `@Inject(MikroOrmDriverProvider)`.
 */
export class PostgresMikroOrmAdapter {
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
      name: 'postgres-mikro-orm',
      module: {
        module: PostgresMikroOrmBatchModule,
        global: true,
        providers: [
          PostgresMikroOrmJobRepository,
          PostgresMikroOrmTransactionManager,
          {
            provide: MikroOrmDriverProvider,
            useExisting: EntityManager,
          },
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: PostgresMikroOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: PostgresMikroOrmTransactionManager,
          },
        ],
        exports: [MikroOrmDriverProvider, JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        {
          provide: MikroOrmDriverProvider,
          useExisting: EntityManager,
        },
        { provide: JOB_REPOSITORY_TOKEN, useClass: PostgresMikroOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: PostgresMikroOrmTransactionManager,
        },
      ],
    };
  }
}
