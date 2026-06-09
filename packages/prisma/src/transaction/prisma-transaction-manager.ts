import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionManager, type TransactionContext } from '@nest-batch/core';
import type { PrismaClient } from '@prisma/client';

export interface PrismaTransactionContext extends TransactionContext {
  readonly isActive: true;
  readonly id: string;
  readonly prisma: PrismaClient;
}

/**
 * TransactionManager bound to Prisma's `$transaction()`.
 *
 * Wraps the user callback in a real DB transaction. On success the
 * transaction commits; if `fn(ctx)` throws, the transaction rolls
 * back.
 *
 * The transactional PrismaClient is the one passed to the callback —
 * consumers should use that `prisma` (not any globally-injected one)
 * so that all reads and writes are part of the same transaction.
 */
@Injectable()
export class PrismaTransactionManager extends TransactionManager {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async withTransaction<T>(
    fn: (ctx: PrismaTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const ctx: PrismaTransactionContext = {
        isActive: true,
        id: randomUUID(),
        prisma: tx as unknown as PrismaClient,
      };
      return fn(ctx);
    });
  }
}
