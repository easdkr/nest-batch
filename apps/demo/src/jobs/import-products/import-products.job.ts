import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Batch,
  BatchScheduled,
  FlowExecutionStatus,
  type ItemExecutionContext,
  type JobParameters,
  type ListenerContext,
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

const DEFAULT_IMPORT_FILE = 'sample-data/products-valid.csv';

/**
 * Decorator-defined 2-step `import-products` batch job.
 *
 * Flow:
 * 1. `validate-csv` checks the import file before item processing.
 * 2. `import-products` reads, validates, and writes products in chunks.
 */
@Injectable()
@Batch.Jobable({ id: 'import-products', restartable: true })
export class ImportProductsJob {
  private readonly logger = new Logger(ImportProductsJob.name);
  private readonly stepStartTimes = new Map<string, number>();

  constructor(
    @Inject(ProductProcessor)
    private readonly productProcessor: ProductProcessor,
    @Inject(ProductWriter)
    private readonly productWriter: ProductWriter,
  ) {}

  @BatchScheduled('0 * * * *', {
    name: 'hourly-import-products',
    timezone: 'UTC',
    overlap: 'skip',
  })
  scheduledImportProducts(): void {
    // Marker method for cron schedule metadata.
  }

  @Batch.Stepable({ id: 'validate-csv' })
  @Batch.Tasklet()
  async validateCsv(ctx: TaskletContext): Promise<{ rows: number }> {
    return new ValidateCsvTasklet(this.resolveFilePath(ctx.jobParameters)).execute(ctx);
  }

  @Batch.Stepable({
    id: 'import-products',
    chunkSize: 10,
    skipPolicy: { limit: 100, skippable: [InvalidProductError, DuplicateSkuError] },
    retryPolicy: {
      limit: 3,
      retryable: [(err) => !(err instanceof Error && err.message.startsWith('Malformed CSV:'))],
      backoff: { type: 'exponential', initialMs: 100 },
    },
  })
  importProducts(): void {
    // Marker method for decorator metadata.
  }

  @Batch.ItemReader({ factory: true })
  createReader(ctx?: ItemExecutionContext): CsvProductReader {
    const itemContext = this.requireItemContext(ctx);
    return new CsvProductReader(this.resolveFilePath(itemContext.jobParameters));
  }

  @Batch.ItemProcessor()
  async process(item: RawProductRow, ctx?: ItemExecutionContext): Promise<ProductEntity | null> {
    return this.productProcessor.process(item, ctx);
  }

  @Batch.ItemWriter()
  async write(items: ProductEntity[], ctx?: ItemExecutionContext): Promise<WriterResult | void> {
    return this.productWriter.write(items, ctx);
  }

  @Batch.OnTransition({
    fromStep: 'validate-csv',
    onStatus: FlowExecutionStatus.COMPLETED,
    toStep: 'import-products',
  })
  afterValidationCompleted(): void {
    // Marker method for decorator metadata.
  }

  @Batch.BeforeJob()
  beforeJob(ctx: ListenerContext): void {
    this.logger.log(
      `Starting import-products with file=${this.resolveFilePath(ctx.jobParameters)}`,
    );
  }

  @Batch.AfterJob()
  afterJob(ctx: ListenerContext, result?: { status?: string }): void {
    this.stepStartTimes.clear();
    this.logger.log(
      `Finished import-products jobExecutionId=${ctx.jobExecutionId} status=${result?.status ?? 'UNKNOWN'}`,
    );
  }

  @Batch.BeforeStep()
  beforeStep(ctx: ListenerContext): void {
    if (ctx.stepExecutionId) {
      this.stepStartTimes.set(ctx.stepExecutionId, Date.now());
    }
    this.logger.log(`Step ${ctx.stepName ?? '<unknown>'} starting`);
  }

  @Batch.AfterStep()
  afterStep(
    ctx: ListenerContext,
    result?: {
      status?: string;
      readCount?: number;
      writeCount?: number;
      skipCount?: number;
    },
  ): void {
    const durationMs =
      ctx.stepExecutionId !== undefined && this.stepStartTimes.has(ctx.stepExecutionId)
        ? Date.now() - this.stepStartTimes.get(ctx.stepExecutionId)!
        : 0;

    if (ctx.stepExecutionId !== undefined) {
      this.stepStartTimes.delete(ctx.stepExecutionId);
    }

    this.logger.log(
      `Step ${ctx.stepName ?? '<unknown>'} ${result?.status ?? 'UNKNOWN'} in ${durationMs}ms ` +
        `(read=${result?.readCount ?? 0}, write=${result?.writeCount ?? 0}, skip=${result?.skipCount ?? 0})`,
    );
  }

  @Batch.BeforeChunk()
  beforeChunk(ctx: ListenerContext): void {
    this.logger.debug(`Chunk ${String(ctx.chunkIndex ?? '?')} starting`);
  }

  @Batch.AfterChunk()
  afterChunk(
    ctx: ListenerContext,
    result?: { readCount?: number; writeCount?: number; skipCount?: number },
  ): void {
    this.logger.debug(
      `Chunk ${String(ctx.chunkIndex ?? '?')} done ` +
        `(read=${result?.readCount ?? 0}, write=${result?.writeCount ?? 0}, skip=${result?.skipCount ?? 0})`,
    );
  }

  @Batch.OnChunkError()
  onChunkError(ctx: ListenerContext, error: unknown): void {
    this.logger.error(`Chunk ${String(ctx.chunkIndex ?? '?')} failed: ${this.formatError(error)}`);
  }

  @Batch.BeforeRead()
  beforeRead(ctx: ListenerContext): void {
    this.logger.debug(`Reading from ${this.resolveFilePath(ctx.jobParameters)}`);
  }

  @Batch.AfterRead()
  afterRead(item: RawProductRow): void {
    this.logger.debug(`Read row sku=${item.sku}`);
  }

  @Batch.OnReadError()
  onReadError(error: unknown, ctx: ListenerContext): void {
    this.logger.warn(
      `Read failed for file=${this.resolveFilePath(ctx.jobParameters)}: ${this.formatError(error)}`,
    );
  }

  @Batch.BeforeProcess()
  beforeProcess(item: RawProductRow): void {
    this.logger.debug(`Processing row sku=${item.sku}`);
  }

  @Batch.AfterProcess()
  afterProcess(item: RawProductRow, result: ProductEntity | null | undefined): void {
    this.logger.debug(result ? `Processed sku=${item.sku}` : `Filtered row sku=${item.sku}`);
  }

  @Batch.OnProcessError()
  onProcessError(item: RawProductRow, error: unknown): void {
    this.logger.warn(`Process skipped sku=${item.sku}: ${this.formatError(error)}`);
  }

  @Batch.BeforeWrite()
  beforeWrite(items: ProductEntity[]): void {
    this.logger.debug(`Writing ${items.length} product(s)`);
  }

  @Batch.AfterWrite()
  afterWrite(items: ProductEntity[], result?: WriterResult | void): void {
    const writerResult = result && typeof result === 'object' ? result : undefined;
    this.logger.debug(
      `Wrote chunk requested=${items.length}, written=${writerResult?.written ?? items.length}, skipped=${writerResult?.skipped ?? 0}`,
    );
  }

  @Batch.OnWriteError()
  onWriteError(items: ProductEntity[], error: unknown): void {
    this.logger.error(`Write failed for ${items.length} product(s): ${this.formatError(error)}`);
  }

  @Batch.OnSkipRead()
  onSkipRead(error: unknown, item: unknown): void {
    this.logger.warn(`Skip read item=${String(item)}: ${this.formatError(error)}`);
  }

  @Batch.OnSkipProcess()
  onSkipProcess(item: RawProductRow, error: unknown): void {
    this.logger.warn(`Skip process sku=${item.sku}: ${this.formatError(error)}`);
  }

  @Batch.OnSkipWrite()
  onSkipWrite(items: ProductEntity[], error: unknown): void {
    this.logger.warn(`Skip write count=${items.length}: ${this.formatError(error)}`);
  }

  private requireItemContext(ctx: ItemExecutionContext | undefined): ItemExecutionContext {
    if (!ctx) {
      throw new Error('ImportProductsJob item handlers require an ItemExecutionContext');
    }
    return ctx;
  }

  private resolveFilePath(params: JobParameters | undefined): string {
    const requested = params?.file;
    if (typeof requested === 'string' && requested.trim().length > 0) {
      return requested;
    }
    return process.env.IMPORT_FILE ?? DEFAULT_IMPORT_FILE;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
