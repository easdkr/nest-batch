import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { TransactionManager, TransactionContext } from '@nest-batch/core';
import { MikroOrmDriverProvider } from './mikro-orm.driver-provider';

export interface MikroOrmTransactionContext extends TransactionContext {
  readonly entityManager: EntityManager;
  readonly isActive: true;
  readonly id: string;
}

/**
 * TransactionManager bound to MikroORM's `EntityManager.transactional()`.
 *
 * Wraps the user callback in a real DB transaction. On success the
 * transaction commits; if `fn(ctx)` throws, the transaction rolls back.
 *
 * The transactional EM is the one passed to the callback — consumers should
 * use that `entityManager` (not any globally-injected one) so that all reads
 * and writes are part of the same transaction.
 *
 * Note: this class is purely a transaction-binder. Job-level and step-level
 * TX semantics (when to begin, how to handle retries, etc.) are the
 * JobExecutor's responsibility, not this adapter's.
 */
@Injectable()
export class MikroORMTransactionManager extends TransactionManager {
  constructor(
    @Inject(MikroOrmDriverProvider) private readonly em: EntityManager,
  ) {
    super();
  }

  async withTransaction<T>(fn: (ctx: MikroOrmTransactionContext) => Promise<T>): Promise<T> {
    return this.em.transactional(async (txEm) => {
      const ctx: MikroOrmTransactionContext = {
        isActive: true,
        id: String(txEm.id),
        entityManager: txEm,
      };
      return fn(ctx);
    });
  }
}
