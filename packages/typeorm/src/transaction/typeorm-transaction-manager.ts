import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  TransactionManager,
  type TransactionContext,
} from '@nest-batch/core';
import { TypeOrmDriverProvider } from '../typeorm.driver-provider';

export interface TypeOrmTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly entityManager: EntityManager;
}

/**
 * TransactionManager bound to TypeORM 1.0.0's `DataSource.transaction()`.
 *
 * Wraps the user callback in a real DB transaction. On success the
 * transaction commits; if `fn(ctx)` throws, the transaction rolls back.
 *
 * The transactional EM is the one passed to the callback —
 * consumers should use that `entityManager` (not any
 * globally-injected one) so that all reads and writes are part of
 * the same transaction.
 */
@Injectable()
export class TypeOrmTransactionManager extends TransactionManager {
  constructor(
    @Inject(TypeOrmDriverProvider) private readonly dataSource: DataSource,
  ) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: TypeOrmTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (txEm) => {
      const ctx: TypeOrmTransactionContext = {
        isActive: true,
        id: randomUUID(),
        entityManager: txEm,
      };
      return fn(ctx);
    });
  }
}
