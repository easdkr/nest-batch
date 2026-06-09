import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import { DrizzleDriverProvider } from '../drizzle.driver-provider';

export interface DrizzleTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly db: unknown;
}

/**
 * TransactionManager bound to Drizzle ORM's `db.transaction()`.
 *
 * Wraps the user callback in a real DB transaction. On success the
 * transaction commits; if `fn(ctx)` throws, the transaction rolls
 * back.
 *
 * The package is driver-agnostic: the actual Drizzle `Database` is
 * provided by the `@nest-batch/postgresql` (or future
 * `@nest-batch/mysql`) driver sibling via the `DrizzleDriverProvider`
 * token. The transaction manager just calls `db.transaction(...)`
 * on the host-owned `Database` instance.
 */
@Injectable()
export class DrizzleTransactionManager extends TransactionManager {
  // `any` is intentional: the slot package doesn't know whether
  // the database is a `NodePgDatabase<typeof schema>` or
  // `MySql2Database<typeof schema>`. The `db.transaction` call is
  // driver-agnostic at the slot layer.
  constructor(@Inject(DrizzleDriverProvider) private readonly db: any) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: DrizzleTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx: unknown) => {
      const ctx: DrizzleTransactionContext = {
        isActive: true,
        id: randomUUID(),
        db: tx,
      };
      return fn(ctx);
    });
  }
}
