import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { PrismaClient } from '@prisma/client';

export interface PostgresPrismaTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly prisma: PrismaClient;
}

/**
 * TransactionManager bound to Prisma's `$transaction()` over a PostgreSQL
 * connection. The shell accepts a `PrismaClient` generated against
 * the PostgreSQL schema bundled in `prisma/schema.prisma`.
 */
@Injectable()
export class PostgresPrismaTransactionManager extends TransactionManager {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: PostgresPrismaTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const ctx: PostgresPrismaTransactionContext = {
        isActive: true,
        id: randomUUID(),
        prisma: tx as unknown as PrismaClient,
      };
      return fn(ctx);
    });
  }
}
