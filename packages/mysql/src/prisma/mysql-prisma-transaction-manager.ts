import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { PrismaClient } from '@prisma/client';

export interface MysqlPrismaTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly prisma: PrismaClient;
}

/**
 * TransactionManager bound to Prisma's `$transaction()` over a MySQL
 * connection. The shell accepts a `PrismaClient` generated against
 * the host app's MySQL Prisma schema.
 */
@Injectable()
export class MysqlPrismaTransactionManager extends TransactionManager {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async withTransaction<T>(fn: (ctx: MysqlPrismaTransactionContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const ctx: MysqlPrismaTransactionContext = {
        isActive: true,
        id: randomUUID(),
        prisma: tx as unknown as PrismaClient,
      };
      return fn(ctx);
    });
  }
}
