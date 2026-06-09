import { Injectable } from '@nestjs/common';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';

import type { MysqlEntityManager } from './mysql-mikroorm-job-repository';

export interface MysqlMikroOrmTransactionContext extends TransactionContext {
  readonly entityManager: MysqlEntityManager;
  readonly isActive: true;
  readonly id: string;
}

/**
 * TransactionManager bound to the MySQL-specific
 * `EntityManager.transactional()` from `@mikro-orm/mysql`.
 *
 * Wraps the user callback in a real MySQL transaction. On success
 * the transaction commits; if `fn(ctx)` throws, the transaction
 * rolls back. The transactional EM is the one passed to the
 * callback — consumers should use that `entityManager` (not any
 * globally-injected one) so all reads and writes are part of the
 * same transaction.
 */
@Injectable()
export class MysqlMikroOrmTransactionManager extends TransactionManager {
  constructor(private readonly em: MysqlEntityManager) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: MysqlMikroOrmTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (txEm) => {
      const ctx: MysqlMikroOrmTransactionContext = {
        isActive: true,
        id: String(txEm.id),
        entityManager: txEm,
      };
      return fn(ctx);
    });
  }
}
