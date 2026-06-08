import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema';

export interface DrizzleTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly db: NodePgDatabase<typeof schema>;
}

/**
 * TransactionManager bound to Drizzle ORM's `db.transaction()`.
 *
 * Wraps the user callback in a real DB transaction. On success the
 * transaction commits; if `fn(ctx)` throws, the transaction rolls
 * back.
 */
@Injectable()
export class DrizzleTransactionManager extends TransactionManager {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: DrizzleTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const ctx: DrizzleTransactionContext = {
        isActive: true,
        id: randomUUID(),
        db: tx as unknown as NodePgDatabase<typeof schema>,
      };
      return fn(ctx);
    });
  }
}
