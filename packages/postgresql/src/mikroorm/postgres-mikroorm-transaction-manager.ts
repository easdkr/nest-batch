import { Injectable } from '@nestjs/common';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';

import type { EntityManager as PostgresEntityManager } from '@mikro-orm/postgresql';

export interface PostgresMikroOrmTransactionContext extends TransactionContext {
  readonly entityManager: PostgresEntityManager;
  readonly isActive: true;
  readonly id: string;
}

/**
 * TransactionManager bound to the Postgres-specific
 * `EntityManager.transactional()` from `@mikro-orm/postgresql`.
 *
 * Wraps the user callback in a real Postgres transaction. On
 * success the transaction commits; if `fn(ctx)` throws, the
 * transaction rolls back. The transactional EM is the one
 * passed to the callback — consumers should use that
 * `entityManager` (not any globally-injected one) so all reads
 * and writes are part of the same transaction.
 *
 * Implementation note: the slot's
 * `MikroORMTransactionManager` (`@nest-batch/mikro-orm`) is
 * driver-agnostic and works for any driver; this class adds
 * only a `PostgresEntityManager` type annotation on the
 * `TransactionContext` shape, so consumers can write
 * type-safe `ctx.entityManager.find(...)` calls against the
 * `@mikro-orm/postgresql` driver. The runtime behavior is
 * identical to `MikroORMTransactionManager.withTransaction` —
 * the type difference is a documentation aid, not a code path.
 */
@Injectable()
export class PostgresMikroOrmTransactionManager extends TransactionManager {
  constructor(private readonly em: PostgresEntityManager) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: PostgresMikroOrmTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (txEm) => {
      const ctx: PostgresMikroOrmTransactionContext = {
        isActive: true,
        id: String(txEm.id),
        entityManager: txEm as PostgresEntityManager,
      };
      return fn(ctx);
    });
  }
}
