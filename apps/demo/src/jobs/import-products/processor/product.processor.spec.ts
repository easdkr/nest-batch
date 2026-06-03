import { describe, expect, test } from 'vitest';
import { ProductProcessor } from './product.processor';
import { ProductEntity } from '../../../entities/product.entity';
import { InvalidProductError } from '../../../errors/invalid-product.error';
import type { RawProductRow } from '../reader/csv-product.reader';

const baseRow: RawProductRow = {
  id: '1',
  name: 'Widget',
  sku: 'SKU-001',
  price: '9.99',
  category: 'electronics',
};

describe('ProductProcessor', () => {
  const processor = new ProductProcessor();

  test('valid row returns a ProductEntity', async () => {
    const result = await processor.process(baseRow);
    expect(result).toBeInstanceOf(ProductEntity);
    expect(result).toMatchObject({
      id: '1',
      name: 'Widget',
      sku: 'SKU-001',
      price: 9.99,
      category: 'electronics',
    });
    expect(result?.createdAt).toBeInstanceOf(Date);
  });

  test('price=0 throws InvalidProductError with field=price', async () => {
    const row: RawProductRow = { ...baseRow, price: '0' };
    await expect(processor.process(row)).rejects.toBeInstanceOf(InvalidProductError);
    try {
      await processor.process(row);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductError);
      const e = err as InvalidProductError;
      expect(e.code).toBe('INVALID_PRODUCT');
      expect(e.field).toBe('price');
      expect(e.value).toBe('0');
      expect(e.message).toContain('Price must be > 0');
    }
  });

  test('invalid category throws InvalidProductError with field=category', async () => {
    const row: RawProductRow = { ...baseRow, category: 'unknown' };
    try {
      await processor.process(row);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductError);
      const e = err as InvalidProductError;
      expect(e.code).toBe('INVALID_PRODUCT');
      expect(e.field).toBe('category');
      expect(e.value).toBe('unknown');
      expect(e.message).toContain('Category must be one of');
    }
  });

  test('missing name throws InvalidProductError with field=name', async () => {
    const row: RawProductRow = { ...baseRow, name: '' };
    try {
      await processor.process(row);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductError);
      const e = err as InvalidProductError;
      expect(e.code).toBe('INVALID_PRODUCT');
      expect(e.field).toBe('name');
      expect(e.value).toBe('');
      expect(e.message).toContain('Name is required');
    }
  });
});
