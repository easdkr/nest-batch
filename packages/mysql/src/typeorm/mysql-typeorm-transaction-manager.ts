import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';

export interface MysqlTypeOrmTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly dataSource: DataSource;
  readonly entityManager: DataSource['manager'];
}

/**
 * TransactionManager bound to TypeORM 1.0.0's `DataSource.transaction()`
 * over the MySQL driver. The shell accepts a `DataSource` configured
 * for MySQL and wraps the user callback in a real MySQL transaction.
 */
@Injectable()
export class MysqlTypeOrmTransactionManager extends TransactionManager {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: MysqlTypeOrmTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      const ctx: MysqlTypeOrmTransactionContext = {
        isActive: true,
        id: randomUUID(),
        dataSource: this.dataSource,
        entityManager: em,
      };
      return fn(ctx);
    });
  }
}
