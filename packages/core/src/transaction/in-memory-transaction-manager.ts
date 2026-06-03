import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TransactionContext, TransactionManager } from '../core/transaction/transaction-manager';

export interface InMemoryTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
}

/**
 * No-op TransactionManager for the in-memory adapter and for tests.
 * Calls `fn(ctx)` directly without any real transactional semantics.
 *
 * For real DB transactions, use a MikroORM/SQL adapter implementation
 * (e.g., `MikroORMTransactionManager`).
 */
@Injectable()
export class InMemoryTransactionManager extends TransactionManager {
  async withTransaction<T>(fn: (ctx: InMemoryTransactionContext) => Promise<T>): Promise<T> {
    const ctx: InMemoryTransactionContext = { isActive: true, id: randomUUID() };
    return fn(ctx);
  }
}
