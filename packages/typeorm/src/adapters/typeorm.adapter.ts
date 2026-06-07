import { Module } from '@nestjs/common';

import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  type BatchAdapter,
} from '@nest-batch/core';

import { TypeOrmJobRepository } from '../repository/typeorm-job-repository';
import { TypeOrmTransactionManager } from '../transaction/typeorm-transaction-manager';

/**
 * Empty Nest module class that owns the TypeORM batch adapter
 * providers.
 *
 * The class has no body on purpose: it is purely a `DynamicModule`
 * carrier for the `forRoot()` factory below. Nest's module system
 * requires *some* class to identify the module — the empty class
 * is the minimum possible surface and keeps the runtime allocation
 * at one class (no decorators, no lifecycle hooks, no metadata).
 */
@Module({})
export class TypeOrmBatchModule {}

/**
 * `TypeOrmAdapter` — the TypeORM 1.0.0 persistence adapter for
 * `@nest-batch/core`.
 *
 * It owns the `JOB_REPOSITORY_TOKEN` and `TRANSACTION_MANAGER_TOKEN`
 * bindings to the TypeORM-backed `TypeOrmJobRepository` /
 * `TypeOrmTransactionManager` implementations. This adapter does
 * not call `TypeOrmModule.forRoot()` — the host must call it in
 * `AppModule.imports` (and register the six batch meta entities
 * on the resulting `DataSource`).
 */
export class TypeOrmAdapter {
  /**
   * Build the `BatchAdapter` value the new factory-pattern
   * `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
   * expects.
   *
   * No options are accepted on purpose — the host already owns
   * the `TypeOrmModule.forRoot(...)` call. The adapter only needs
   * to declare its own provider / export / `globalProviders`
   * surface; the `DataSource` itself is the host's responsibility.
   *
   * @returns A `BatchAdapter` whose `module` is a `global: true`
   *   `DynamicModule` exposing `JOB_REPOSITORY_TOKEN` and
   *   `TRANSACTION_MANAGER_TOKEN` to the host application.
   */
  static forRoot(): BatchAdapter {
    return {
      name: 'typeorm',
      module: {
        module: TypeOrmBatchModule,
        global: true,
        providers: [
          TypeOrmJobRepository,
          TypeOrmTransactionManager,
          {
            provide: JOB_REPOSITORY_TOKEN,
            useExisting: TypeOrmJobRepository,
          },
          {
            provide: TRANSACTION_MANAGER_TOKEN,
            useExisting: TypeOrmTransactionManager,
          },
        ],
        exports: [JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN],
      },
      globalProviders: [
        { provide: JOB_REPOSITORY_TOKEN, useClass: TypeOrmJobRepository },
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useClass: TypeOrmTransactionManager,
        },
      ],
    };
  }
}


