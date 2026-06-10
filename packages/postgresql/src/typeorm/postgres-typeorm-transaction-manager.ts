import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';

export interface PostgresTypeOrmTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly dataSource: DataSource;
  readonly entityManager: DataSource['manager'];
}

/**
 * TransactionManager bound to TypeORM 1.0.0's `DataSource.transaction()`
 * over the Postgres driver. The shell accepts a `DataSource` configured
 * for Postgres (via the `pg` driver / `type: 'postgres'`) and wraps the
 * user callback in a real Postgres transaction.
 *
 * The body is driver-agnostic: `DataSource.transaction()` is the same
 * API surface for both `mysql2` and `pg`. The driver choice is encoded
 * in the host's `TypeOrmModule.forRoot({ type: 'postgres', ... })` call,
 * not in this file.
 */
@Injectable()
export class PostgresTypeOrmTransactionManager extends TransactionManager {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: PostgresTypeOrmTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      const ctx: PostgresTypeOrmTransactionContext = {
        isActive: true,
        id: randomUUID(),
        dataSource: this.dataSource,
        entityManager: em,
      };
      return fn(ctx);
    });
  }
}
