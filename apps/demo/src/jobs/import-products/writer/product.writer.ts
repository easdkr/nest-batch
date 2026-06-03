import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ItemWriter } from '@nest-batch/core';
import { ProductEntity } from '../../../entities/product.entity';
import { DuplicateSkuError } from '../../../errors/duplicate-sku.error';

@Injectable()
export class ProductWriter implements ItemWriter<ProductEntity> {
  private readonly logger = new Logger(ProductWriter.name);

  constructor(private readonly em: EntityManager) {}

  async write(items: ProductEntity[]): Promise<{ written: number; skipped: number }> {
    if (items.length === 0) return { written: 0, skipped: 0 };
    const failedSkus: string[] = [];
    let written = 0;
    for (const item of items) {
      try {
        // Per-row savepoint: when called inside the chunk-executor's
        // outer transaction (via transactionManager.withTransaction), the
        // surrounding TX is preserved on failure — only this savepoint
        // rolls back, so the next row in the same chunk can still commit.
        // When called outside any TX, em.transactional opens a fresh
        // top-level transaction for the row.
        await this.em.transactional(async (txEm) => {
          await txEm.persistAndFlush(item);
        });
        written += 1;
      } catch (err) {
        if (err instanceof UniqueConstraintViolationException) {
          failedSkus.push(item.sku);
          continue;
        }
        throw err;
      }
    }
    return { written, skipped: failedSkus.length };
  }
}
