import { describe, expect, test, vi } from 'vitest';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { ProductWriter } from './product.writer';
import { ProductEntity } from '../../../entities/product.entity';

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

function makeEm(
  opts: { throwUniqueFor?: Set<string> } = {},
): { em: any; persistAndFlush: ReturnType<typeof vi.fn> } {
  const persistAndFlush = vi.fn(async (item: ProductEntity) => {
    if (opts.throwUniqueFor?.has(item.sku)) {
      // Simulate the underlying driver error wrapped in MikroORM's
      // UniqueConstraintViolationException.
      const driverErr = new Error('duplicate key value violates unique constraint');
      throw new UniqueConstraintViolationException(driverErr);
    }
  });
  // ProductWriter.write() wraps each persistAndFlush in em.transactional;
  // the mock invokes the callback with a fake txEm that delegates to the
  // same persistAndFlush spy so call-count assertions still observe it.
  const transactional = vi.fn(async (fn: (txEm: any) => Promise<any>) => {
    return fn({ persistAndFlush, flush: vi.fn() });
  });
  const em = { persistAndFlush, transactional };
  return { em, persistAndFlush };
}

describe('ProductWriter', () => {
  test('writes 3 valid products via persistAndFlush and returns { written: 3, skipped: 0 }', async () => {
    const { em, persistAndFlush } = makeEm();
    const writer = new ProductWriter(em);
    const items = [makeEntity('SKU-001'), makeEntity('SKU-002'), makeEntity('SKU-003')];

    const result = await writer.write(items);

    // Per-row savepoint: persistAndFlush is called once per item.
    expect(persistAndFlush).toHaveBeenCalledTimes(3);
    expect(persistAndFlush).toHaveBeenNthCalledWith(1, items[0]);
    expect(persistAndFlush).toHaveBeenNthCalledWith(2, items[1]);
    expect(persistAndFlush).toHaveBeenNthCalledWith(3, items[2]);
    expect(result).toEqual({ written: 3, skipped: 0 });
  });

  test('duplicate SKUs are skipped per row and surfaced as { written, skipped } — does not throw', async () => {
    const { em, persistAndFlush } = makeEm({ throwUniqueFor: new Set(['SKU-002']) });
    const writer = new ProductWriter(em);
    const items = [
      makeEntity('SKU-001'),
      makeEntity('SKU-002'),
      makeEntity('SKU-003'),
    ];

    const result = await writer.write(items);

    expect(persistAndFlush).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ written: 2, skipped: 1 });
  });

  test('all rows duplicate → returns { written: 0, skipped: N } without throwing', async () => {
    const skus = ['SKU-001', 'SKU-002', 'SKU-003'];
    const { em, persistAndFlush } = makeEm({ throwUniqueFor: new Set(skus) });
    const writer = new ProductWriter(em);
    const items = skus.map((s) => makeEntity(s));

    const result = await writer.write(items);

    expect(persistAndFlush).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ written: 0, skipped: 3 });
  });

  test('non-unique-constraint error re-throws (does not get swallowed as a skip)', async () => {
    // Generic Error (not a UniqueConstraintViolationException) must
    // propagate so the chunk-step executor's retry/skip policy can act.
    const persistAndFlush = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const transactional = vi.fn(async (fn: (txEm: any) => Promise<any>) => {
      return fn({ persistAndFlush, flush: vi.fn() });
    });
    const em: any = { persistAndFlush, transactional };
    const writer = new ProductWriter(em);

    await expect(writer.write([makeEntity('SKU-001')])).rejects.toThrow(
      'connection refused',
    );
  });

  test('empty items array is a no-op (persistAndFlush not called)', async () => {
    const { em, persistAndFlush } = makeEm();
    const writer = new ProductWriter(em);

    const result = await writer.write([]);

    expect(persistAndFlush).not.toHaveBeenCalled();
    expect(result).toEqual({ written: 0, skipped: 0 });
  });
});
