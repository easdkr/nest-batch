import { Injectable } from '@nestjs/common';
import {
  BatchBuilder,
  FlowExecutionStatus,
  RefKind,
  type ItemProcessor,
  type ItemReader,
  type ItemWriter,
  type JobBuilderConfig,
} from '@nest-batch/core';
import { CsvProductReader } from './reader/csv-product.reader';
import { ProductProcessor } from './processor/product.processor';
import { ProductWriter } from './writer/product.writer';
import { ValidateCsvTasklet } from './validate-csv.tasklet';
import { InvalidProductError } from '../../errors/invalid-product.error';
import { DuplicateSkuError } from '../../errors/duplicate-sku.error';

/**
 * `ImportProductsJob` — static factory for the 2-step `import-products`
 * batch job (CSV → Product import).
 *
 * Linear flow:
 *   1. `validate-csv`  — tasklet step that pre-checks the file
 *                         (existence + non-empty data rows). Throws on
 *                         bad input, so the chunk step never runs.
 *   2. `import-products` — chunk step (size 10) that reads the CSV
 *                           row-by-row, validates via the processor,
 *                           and bulk-inserts via the writer.
 *
 * The chunk step is configured with:
 *   - **SkipPolicy**: rows that fail validation or duplicate an existing
 *     SKU are skipped (up to 100 per execution) rather than failing
 *     the whole batch.
 *   - **RetryPolicy**: 3 retries with exponential backoff for transient
 *     errors (catches any `Error` here for MVP — the demo's writer
 *     maps unique-constraint violations to `DuplicateSkuError`, which
 *     the skip policy then handles).
 *
 * The job is restartable so a partially-completed execution can be
 * resumed after a crash (the library's MVP restart semantics — see
 * Task 37).
 *
 * The explicit `validate-csv → import-products` transition is declared
 * on COMPLETED so the `DefinitionValidator` (which requires every step
 * to be reachable from `startStepId`) accepts the linear graph; the
 * `JobExecutor`'s linear-fallback would otherwise also work, but the
 * validator is stricter and rejects graphs without transitions.
 *
 * Per-launch reader/processor/writer instance memoization:
 *   The `BuilderLambda` resolver in `ChunkStepExecutor` expects each
 *   lambda to return an `ItemReader` / `ItemProcessor` / `ItemWriter`
 *   instance (an object with the corresponding method), NOT a thunk
 *   that creates a new instance per call. To make the file-path /
 *   DI-bound instance work with a per-launch file path, the factories
 *   below memoize the instance on first invocation and return bound
 *   method objects. This keeps the chunk executor's expectations
 *   (one instance, stable identity across read/process/write calls)
 *   while still allowing the providers to receive their file-path /
 *   EntityManager dependencies at build time.
 *
 * The returned `JobBuilderConfig` is consumed by `DefinitionCompiler.
 * compileFromBuilderConfig` in the AppModule factory; it does not
 * register the job itself.
 */
@Injectable()
export class ImportProductsJob {
  static build(
    filePath: string,
    readerProvider: () => CsvProductReader,
    processorProvider: () => ProductProcessor,
    writerProvider: () => ProductWriter,
  ): JobBuilderConfig {
    // Memoize the instances so the chunk executor sees a stable
    // reader/processor/writer across all read/process/write calls in
    // the chunk loop. Without this, each `read()` would create a
    // brand-new `CsvProductReader`, re-opening the file from byte 0
    // and producing an infinite loop.
    let readerInstance: ItemReader | null = null;
    let processorInstance: ItemProcessor | null = null;
    let writerInstance: ItemWriter | null = null;

    const resolveReader = (): ItemReader => {
      if (!readerInstance) {
        const r = readerProvider();
        readerInstance = { read: r.read.bind(r) };
      }
      return readerInstance;
    };
    const resolveProcessor = (): ItemProcessor => {
      if (!processorInstance) {
        const p = processorProvider();
        processorInstance = { process: p.process.bind(p) };
      }
      return processorInstance;
    };
    const resolveWriter = (): ItemWriter => {
      if (!writerInstance) {
        const w = writerProvider();
        writerInstance = { write: w.write.bind(w) };
      }
      return writerInstance;
    };

    return BatchBuilder.create()
      .job('import-products')
      .restartable(true)
      .addStep((s) =>
        s.tasklet('validate-csv', {
          kind: RefKind.BuilderLambda,
          fn: () => new ValidateCsvTasklet(filePath),
        }),
      )
      .addStep((s) =>
        s.chunk('import-products', 10, {
          reader: {
            kind: RefKind.BuilderLambda,
            fn: () => resolveReader(),
          },
          processor: {
            kind: RefKind.BuilderLambda,
            fn: () => resolveProcessor(),
          },
          writer: {
            kind: RefKind.BuilderLambda,
            fn: () => resolveWriter(),
          },
          skipPolicy: { limit: 100, skippable: [InvalidProductError, DuplicateSkuError] },
          retryPolicy: {
            limit: 3,
            retryable: [Error],
            backoff: { type: 'exponential', initialMs: 100 },
          },
        }),
      )
      .from('validate-csv')
      .on(FlowExecutionStatus.COMPLETED)
      .to('import-products')
      .build();
  }
}
