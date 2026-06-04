import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ItemWriter, WriterResult } from '@nest-batch/core';
import { ProductEntity } from '../../../entities/product.entity';

@Injectable()
export class ProductWriter implements ItemWriter<ProductEntity> {
  private readonly logger = new Logger(ProductWriter.name);

  constructor(private readonly em: EntityManager) {}

  async write(items: ProductEntity[]): Promise<WriterResult> {
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
          // Duplicate SKU — record it and continue. The chunk-step
          // executor reads `skipped` from the returned WriterResult
          // and rolls it into the step's `skipCount` / `writeCount`,
          // so duplicates are accounted for as skips rather than
          // failing the whole chunk (Spring Batch pattern).
          failedSkus.push(item.sku);
          continue;
        }
        // Non-unique-constraint error: real failure. Re-throw so the
        // chunk-step executor's retry/skip policy sees it.
        throw err;
      }
    }
    if (failedSkus.length > 0) {
      this.logger.warn(
        `Skipped ${failedSkus.length} row(s) with duplicate SKU: ${failedSkus.join(', ')}`,
      );
    }
    return { written, skipped: failedSkus.length };
  }
}
