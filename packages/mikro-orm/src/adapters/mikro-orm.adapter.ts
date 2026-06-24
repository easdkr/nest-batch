import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';
import { MikroOrmDriverProvider } from '../mikro-orm.driver-provider';
import { MikroORMJobRepository } from '../mikroorm-job-repository';
import { MikroORMTransactionManager } from '../mikroorm-transaction-manager';

/**
 * Empty Nest module class that owns the MikroORM batch adapter
 * providers.
 *
 * The class has no body on purpose: it is purely a `DynamicModule`
 * carrier for the `forRoot()` factory below. Nest's module system
 * requires *some* class to identify the module — the empty class
 * is the minimum possible surface and keeps the runtime allocation
 * at one class (no decorators, no lifecycle hooks, no metadata).
 */
@Module({})
export class MikroOrmAdapterModule {}

/**
 * `MikroOrmAdapter` — the MikroORM 6.x persistence adapter for
 * `@nest-batch/core`.
 *
 * It owns the `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 * bindings to the MikroORM-backed `MikroORMJobRepository` /
 * `MikroORMTransactionManager` implementations. This adapter does
 * not call `MikroOrmModule.forRoot()` — the host must call it in
 * `AppModule.imports` (and spread `BATCH_META_ENTITIES` into its
 * `entities` array).
 */
export class MikroOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `MikroOrmModule.forRoot(...)` call. The adapter only needs
   * to declare its own provider / export / `globalProviders`
   * surface. The host still owns `MikroOrmModule.forRoot(...)`; this
   * adapter only aliases the host `EntityManager` to the batch driver
   * token.
   *
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` exposing `JOB_REPOSITORY_TOKEN` and
   *   `TRANSACTION_MANAGER_TOKEN` to the host application.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'mikro-orm',
      module: {
        module: MikroOrmAdapterModule,
        global: true,
        providers: [
          MikroORMJobRepository,
          MikroORMTransactionManager,
          {
            provide: MikroOrmDriverProvider,
            useExisting: EntityManager,
          },
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: MikroORMJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: MikroORMTransactionManager,
          },
        ],
        exports: [MikroOrmDriverProvider, JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        {
          provide: MikroOrmDriverProvider,
          useExisting: EntityManager,
        },
        { provide: JOB_REPOSITORY_TOKEN, useClass: MikroORMJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: MikroORMTransactionManager,
        },
      ],
    };
  }
}
