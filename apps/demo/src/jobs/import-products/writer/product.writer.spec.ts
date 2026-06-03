import { describe, expect, test, vi } from 'vitest';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { ProductWriter } from './product.writer';
import { ProductEntity } from '../../../entities/product.entity';
import { DuplicateSkuError } from '../../../errors/duplicate-sku.error';

function makeEntity(sku: string, name = 'Widget'): ProductEntity {
  const e = new ProductEntity();
  e.id = `id-${sku}`;
  e.name = name;
  e.sku = sku;
  e.price = 9.99;
  e.category = 'electronics';
  e.createdAt = new Date();
  return e;
}

function makeEm(opts: { throwUnique?: boolean } = {}): { em: any; persistAndFlush: ReturnType<typeof vi.fn> } {
  const persistAndFlush = vi.fn(async (items: ProductEntity[]) => {
    if (opts.throwUnique) {
      // Simulate the underlying driver error wrapped in MikroORM's
      // UniqueConstraintViolationException.
      const driverErr = new Error('duplicate key value violates unique constraint');
      throw new UniqueConstraintViolationException(driverErr);
    }
  });
  const em = { persistAndFlush };
  return { em, persistAndFlush };
}

describe('ProductWriter', () => {
  test('writes 3 valid products via persistAndFlush', async () => {
    const { em, persistAndFlush } = makeEm();
    const writer = new ProductWriter(em);
    const items = [makeEntity('SKU-001'), makeEntity('SKU-002'), makeEntity('SKU-003')];

    await writer.write(items);

    expect(persistAndFlush).toHaveBeenCalledTimes(1);
    expect(persistAndFlush).toHaveBeenCalledWith(items);
  });

  test('2 valid + 1 with duplicate SKU throws DuplicateSkuError', async () => {
    const { em, persistAndFlush } = makeEm({ throwUnique: true });
    const writer = new ProductWriter(em);
    const items = [
      makeEntity('SKU-001'),
      makeEntity('SKU-002'),
      makeEntity('SKU-003'), // last one — surfaced as the duplicate
    ];

    await expect(writer.write(items)).rejects.toBeInstanceOf(DuplicateSkuError);

    try {
      await writer.write(items);
    } catch (err) {
      const e = err as DuplicateSkuError;
      expect(e.code).toBe('DUPLICATE_SKU');
      expect(e.sku).toBe('SKU-003');
      expect(e.message).toContain('Duplicate SKU: SKU-003');
    }
    // persistAndFlush is invoked (and rejects) for each call above.
    expect(persistAndFlush).toHaveBeenCalled();
  });

  test('empty items array is a no-op (persistAndFlush not called)', async () => {
    const { em, persistAndFlush } = makeEm();
    const writer = new ProductWriter(em);

    await writer.write([]);

    expect(persistAndFlush).not.toHaveBeenCalled();
  });
});
