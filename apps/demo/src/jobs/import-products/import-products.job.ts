import { Injectable } from '@nestjs/common';
import {
  BatchDecorators,
  FlowExecutionStatus,
  type TaskletContext,
  type WriterResult,
} from '@nest-batch/core';
import { ProductEntity } from '../../entities/product.entity';
import { DuplicateSkuError } from '../../errors/duplicate-sku.error';
import { InvalidProductError } from '../../errors/invalid-product.error';
import { ProductProcessor } from './processor/product.processor';
import { CsvProductReader, type RawProductRow } from './reader/csv-product.reader';
import { ValidateCsvTasklet } from './validate-csv.tasklet';
import { ProductWriter } from './writer/product.writer';

/**
 * Decorator-defined 2-step `import-products` batch job.
 *
 * Flow:
 * 1. `validate-csv` checks the import file before item processing.
 * 2. `import-products` reads, validates, and writes products in chunks.
 */
@Injectable()
@BatchDecorators.Jobable({ id: 'import-products', restartable: true })
export class ImportProductsJob {
  private filePath?: string;
  private reader?: CsvProductReader;

  constructor(
    private readonly productProcessor: ProductProcessor,
    private readonly productWriter: ProductWriter,
  ) {}

  configure(filePath: string): void {
    this.filePath = filePath;
    this.reader = undefined;
  }

  @BatchDecorators.Stepable({ id: 'validate-csv' })
  @BatchDecorators.Tasklet()
  async validateCsv(ctx: TaskletContext): Promise<{ rows: number }> {
    return new ValidateCsvTasklet(this.requireFilePath()).execute(ctx);
  }

  @BatchDecorators.Stepable({
    id: 'import-products',
    chunkSize: 10,
    skipPolicy: { limit: 100, skippable: [InvalidProductError, DuplicateSkuError] },
    retryPolicy: {
      limit: 3,
      retryable: [
        (err) => !(err instanceof Error && err.message.startsWith('Malformed CSV:')),
      ],
      backoff: { type: 'exponential', initialMs: 100 },
    },
  })
  importProducts(): void {
    // Marker method for decorator metadata.
  }

  @BatchDecorators.ItemReader()
  async read(): Promise<RawProductRow | null> {
    return this.requireReader().read();
  }

  @BatchDecorators.ItemProcessor()
  async process(item: RawProductRow): Promise<ProductEntity | null> {
    return this.productProcessor.process(item);
  }

  @BatchDecorators.ItemWriter()
  async write(items: ProductEntity[]): Promise<WriterResult | void> {
    return this.productWriter.write(items);
  }

  @BatchDecorators.OnTransition({
    fromStep: 'validate-csv',
    onStatus: FlowExecutionStatus.COMPLETED,
    toStep: 'import-products',
  })
  afterValidationCompleted(): void {
    // Marker method for decorator metadata.
  }

  private requireReader(): CsvProductReader {
    if (!this.reader) {
      this.reader = new CsvProductReader(this.requireFilePath());
    }
    return this.reader;
  }

  private requireFilePath(): string {
    if (!this.filePath) {
      throw new Error('ImportProductsJob is not configured with a CSV file path');
    }
    return this.filePath;
  }
}
