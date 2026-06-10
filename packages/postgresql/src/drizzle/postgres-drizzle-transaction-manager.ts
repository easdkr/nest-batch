import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle-schema.postgres';

export interface PostgresDrizzleTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly db: NodePgDatabase<typeof schema>;
}

/**
 * TransactionManager bound to Drizzle's `NodePgDatabase.transaction()`.
 *
 * Postgres-flavored mirror of the MySQL shell
 * (`@nest-batch/mysql`'s `MysqlDrizzleTransactionManager`). The
 * only differences are the schema source
 * (`drizzle-schema.postgres.ts` instead of `schema.ts`) and the
 * `NodePgDatabase` typing from `drizzle-orm/node-postgres`.
 */
@Injectable()
export class PostgresDrizzleTransactionManager extends TransactionManager {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: PostgresDrizzleTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const ctx: PostgresDrizzleTransactionContext = {
        isActive: true,
        id: randomUUID(),
        db: tx as unknown as NodePgDatabase<typeof schema>,
      };
      return fn(ctx);
    });
  }
}
