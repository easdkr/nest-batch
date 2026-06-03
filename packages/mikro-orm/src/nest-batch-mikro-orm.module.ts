import { DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule, type MikroOrmModuleOptions } from '@mikro-orm/nestjs';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  JobExecutionParamsEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from './entities/job-meta.entities';

/**
 * The list of batch meta-entities owned by `@nest-batch/mikro-orm`.
 *
 * Apps that already configure `MikroOrmModule.forRoot()` with their
 * own user-domain entities should spread this list into their
 * `entities` array so the batch meta tables are wired in:
 *
 *   import { BATCH_META_ENTITIES, MikroORMJobRepository, MikroORMTransactionManager } from '@nest-batch/mikro-orm';
 *
 *   MikroOrmModule.forRoot({
 *     entities: [
 *       ...BATCH_META_ENTITIES,
 *       ProductEntity, // user-domain
 *     ],
 *     // ...
 *   })
 */
export const BATCH_META_ENTITIES = [
  JobInstanceEntity,
  JobExecutionEntity,
  JobExecutionParamsEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
] as const;

/**
 * Nest module that registers the `MikroORMJobRepository` and
 * `MikroORMTransactionManager` providers against the
 * `@nest-batch/core` `JobRepository` / `TransactionManager` tokens.
 *
 * Apps that already call `MikroOrmModule.forRoot()` (with
 * `...BATCH_META_ENTITIES` spread into `entities`) just import
 * this module — no further wiring is required:
 *
 *   @Module({
 *     imports: [
 *       MikroOrmModule.forRoot({ entities: [...BATCH_META_ENTITIES, ProductEntity], ... }),
 *       NestBatchBatchModule,
 *     ],
 *   })
 *   class AppModule {}
 *
 * For hosts that need a self-contained module (MikroORM + batch
 * entities + repository/transaction-manager providers all in one),
 * use `NestBatchMikroOrmModule.forRootAsync()` with a config that
 * includes `BATCH_META_ENTITIES`.
 */
@Module({
  providers: [],
  exports: [],
})
export class NestBatchMikroOrmModule {
  /**
   * Self-contained module: registers `MikroOrmModule.forRoot()` with
   * the batch meta-entities pre-populated, plus the
   * `JobRepository` / `TransactionManager` providers.
   *
   * The `options` are passed through to `MikroOrmModule.forRoot()`
   * unchanged except for the `entities` field, which is merged with
   * `BATCH_META_ENTITIES` (the host's user-domain entities remain
   * authoritative; the package entities are appended).
   */
  static forRoot(options: Omit<MikroOrmModuleOptions, 'entities'> & {
    entities?: MikroOrmModuleOptions['entities'];
  }): DynamicModule {
    const merged: MikroOrmModuleOptions = {
      ...options,
      entities: [...(options.entities ?? []), ...BATCH_META_ENTITIES],
    };
    return {
      module: NestBatchMikroOrmModule,
      imports: [MikroOrmModule.forRoot(merged)],
    };
  }
}
