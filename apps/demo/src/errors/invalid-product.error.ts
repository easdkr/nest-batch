import { BatchError } from '@nest-batch/core';

export class InvalidProductError extends BatchError {
  readonly code = 'INVALID_PRODUCT';
  constructor(public readonly field: string, public readonly value: string, message?: string) {
    super(message ?? `Invalid product field "${field}": ${value}`, { field, value });
  }
}
