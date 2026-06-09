import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema';

export interface MysqlDrizzleTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly db: MySql2Database<typeof schema>;
}

/**
 * TransactionManager bound to Drizzle's `MySql2Database.transaction()`.
 */
@Injectable()
export class MysqlDrizzleTransactionManager extends TransactionManager {
  constructor(private readonly db: MySql2Database<typeof schema>) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: MysqlDrizzleTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const ctx: MysqlDrizzleTransactionContext = {
        isActive: true,
        id: randomUUID(),
        db: tx as unknown as MySql2Database<typeof schema>,
      };
      return fn(ctx);
    });
  }
}
