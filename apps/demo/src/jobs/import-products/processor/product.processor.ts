import { Injectable } from '@nestjs/common';
import { ItemProcessor } from '@nest-batch/core';
import { ProductEntity } from '../../../entities/product.entity';
import { isValidCategory, VALID_CATEGORIES } from '../../../constants/categories';
import { InvalidProductError } from '../../../errors/invalid-product.error';
import type { RawProductRow } from '../reader/csv-product.reader';

@Injectable()
export class ProductProcessor implements ItemProcessor<RawProductRow, ProductEntity | null> {
  async process(item: RawProductRow): Promise<ProductEntity | null> {
    // eslint-disable-next-line no-console
    console.log('[DEBUG] processor: item=', typeof item, item instanceof Object ? JSON.stringify(Object.keys(item)) : item);
    // Validate
    if (!item.name || item.name.trim() === '') {
      throw new InvalidProductError('name', item.name ?? '', 'Name is required');
    }
    if (!item.sku || item.sku.trim() === '') {
      throw new InvalidProductError('sku', item.sku ?? '', 'SKU is required');
    }
    const price = parseFloat(item.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new InvalidProductError('price', item.price, 'Price must be > 0');
    }
    if (!isValidCategory(item.category)) {
      throw new InvalidProductError(
        'category',
        item.category,
        `Category must be one of: ${VALID_CATEGORIES.join(', ')}`,
      );
    }

    // Build entity
    const entity = new ProductEntity();
    entity.id = item.id || `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    entity.name = item.name;
    entity.sku = item.sku;
    entity.price = price;
    entity.category = item.category;
    entity.createdAt = new Date();
    return entity;
  }
}
