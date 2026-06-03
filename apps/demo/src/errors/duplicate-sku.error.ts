import { BatchError } from '@nest-batch/core';

export class DuplicateSkuError extends BatchError {
  readonly code = 'DUPLICATE_SKU';
  constructor(public readonly sku: string) {
    super(`Duplicate SKU: ${sku}`, { sku });
  }
}
