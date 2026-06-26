import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BATCH_SCHEDULED_OPTIONS,
  InMemoryJobRepository,
  InMemoryTransactionManager,
  InProcessAdapter,
  JOB_REPOSITORY_TOKEN,
  JobLauncher,
  JobRepository,
  JobStatus,
  NestBatchModule,
  TRANSACTION_MANAGER_TOKEN,
  TransactionManager,
  type BatchAdapter,
} from '@nest-batch/core';
import type {
  ExecutionContext,
  ItemExecutionContext,
  JobParameters,
  TaskletContext,
} from '@nest-batch/core';

import { ProductEntity } from '../../entities/product.entity';
import { ImportProductsJob } from './import-products.job';
import { ProductProcessor } from './processor/product.processor';
import type { RawProductRow } from './reader/csv-product.reader';
import { ProductWriter } from './writer/product.writer';

function makeCsv(content: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'import-products-job-spec-'));
  const file = join(dir, 'data.csv');
  writeFileSync(file, content);
  return { file, dir };
}

const VALID_HEADER = 'id,name,sku,price,category';
const VALID_CSV = `${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n`;

function inMemoryPersistenceAdapter(
  repository: InMemoryJobRepository,
  transactionManager: InMemoryTransactionManager,
): BatchAdapter {
  return {
    name: 'in-memory-smoke',
    module: { module: class InMemorySmokePersistenceModule {} },
    globalProviders: [
      { provide: InMemoryJobRepository, useValue: repository },
      { provide: JOB_REPOSITORY_TOKEN, useValue: repository },
      { provide: InMemoryTransactionManager, useValue: transactionManager },
      { provide: TRANSACTION_MANAGER_TOKEN, useValue: transactionManager },
      { provide: JobRepository, useExisting: JOB_REPOSITORY_TOKEN },
      { provide: TransactionManager, useExisting: TRANSACTION_MANAGER_TOKEN },
    ],
  };
}

describe('ImportProductsJob', () => {
  let job: ImportProductsJob;
  let processor: ProductProcessor;
  let writer: ProductWriter;
  let tmpDirs: string[];

  beforeEach(() => {
    processor = new ProductProcessor();
    writer = new ProductWriter({} as any);
    job = new ImportProductsJob(processor, writer);
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function csv(content: string): string {
    const { file, dir } = makeCsv(content);
    tmpDirs.push(dir);
    return file;
  }

  function taskletContext(file: string): TaskletContext {
    return {
      jobExecutionId: 'job-exec-1',
      stepExecutionId: 'validate-step-1',
      jobParameters: { file },
      getExecutionContext: async () => ({ data: null, version: 0 }),
      saveExecutionContext: async (_ctx: ExecutionContext) => undefined,
    };
  }

  function itemContext(file: string, stepExecutionId = 'import-step-1'): ItemExecutionContext {
    return {
      jobExecutionId: 'job-exec-1',
      stepExecutionId,
      stepName: 'import-products',
      jobParameters: { file } satisfies JobParameters,
      chunkIndex: 0,
      getExecutionContext: async () => ({ data: null, version: 0 }),
      saveExecutionContext: async (_ctx: ExecutionContext) => undefined,
    };
  }

  describe('@BatchScheduled', () => {
    test('declares cron schedule metadata for production-style launches', () => {
      const meta = Reflect.getMetadata(
        BATCH_SCHEDULED_OPTIONS,
        ImportProductsJob.prototype.scheduledImportProducts,
      );

      expect(meta).toMatchObject({
        cron: '0 * * * *',
        options: {
          name: 'hourly-import-products',
          timezone: 'UTC',
          overlap: 'skip',
        },
      });
    });

    test('fires the decorated cron through InProcessAdapter and runs import-products', async () => {
      const repository = new InMemoryJobRepository();
      const transactionManager = new InMemoryTransactionManager();
      const writerStub = {
        write: vi.fn(async (items: ProductEntity[]) => ({
          written: items.length,
          skipped: 0,
        })),
      };
      const launchSpy = vi.spyOn(JobLauncher.prototype, 'launch');
      const originalImportFile = process.env.IMPORT_FILE;
      let moduleRef: TestingModule | undefined;

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:59:30.000Z'));
      process.env.IMPORT_FILE = csv(VALID_CSV);

      try {
        moduleRef = await Test.createTestingModule({
          imports: [
            NestBatchModule.forRoot({
              adapters: {
                persistence: inMemoryPersistenceAdapter(repository, transactionManager),
                transport: InProcessAdapter.forRoot(),
              },
            }),
          ],
          providers: [
            ProductProcessor,
            { provide: ProductWriter, useValue: writerStub },
            ImportProductsJob,
          ],
        }).compile();

        await moduleRef.init();

        await vi.advanceTimersByTimeAsync(29_999);
        expect(launchSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(launchSpy).toHaveBeenCalledTimes(1);
        expect(launchSpy).toHaveBeenCalledWith('import-products', {
          scheduled: true,
          scheduleName: 'hourly-import-products',
          scheduledAt: '2026-01-01T01:00:00.000Z',
        });

        const launchResult = launchSpy.mock.results[0];
        if (!launchResult || launchResult.type !== 'return') {
          throw new Error('Scheduled cron did not return a JobLauncher launch promise');
        }

        vi.useRealTimers();
        const execution = await launchResult.value;

        expect(execution.status).toBe(JobStatus.COMPLETED);
        expect(writerStub.write).toHaveBeenCalledTimes(1);
        expect(writerStub.write.mock.calls[0]?.[0]).toHaveLength(1);

        const executions = await repository.findJobExecutions();
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({
          id: execution.id,
          status: JobStatus.COMPLETED,
          params: {
            scheduled: true,
            scheduleName: 'hourly-import-products',
            scheduledAt: '2026-01-01T01:00:00.000Z',
          },
        });
      } finally {
        await moduleRef?.close();
        launchSpy.mockRestore();
        if (originalImportFile === undefined) {
          delete process.env.IMPORT_FILE;
        } else {
          process.env.IMPORT_FILE = originalImportFile;
        }
        vi.useRealTimers();
      }
    });
  });

  describe('validateCsv(ctx)', () => {
    test('resolves the CSV path from jobParameters.file', async () => {
      const result = await job.validateCsv(taskletContext(csv(VALID_CSV)));
      expect(result).toEqual({ rows: 1 });
    });

    test('returns { rows: N } where N matches the data rows in the file', async () => {
      const file = csv(
        `${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n2,Gadget,SKU-2,19.99,food\n3,Bolt,SKU-3,5.00,clothing\n`,
      );
      const result = await job.validateCsv(taskletContext(file));
      expect(result).toEqual({ rows: 3 });
    });

    test('propagates the tasklet error when the file does not exist', async () => {
      await expect(
        job.validateCsv(taskletContext('/nonexistent/path/that/should/not/exist.csv')),
      ).rejects.toThrow(/CSV file not found/);
    });

    test('propagates the tasklet error when the file has no data rows', async () => {
      await expect(job.validateCsv(taskletContext(csv(`${VALID_HEADER}\n`)))).rejects.toThrow(
        /at least 1 data row/,
      );
    });
  });

  describe('createReader(ctx)', () => {
    test('throws when the reader factory is called without runtime context', () => {
      expect(() => job.createReader()).toThrow(/ItemExecutionContext/);
    });

    test('returns a reader for jobParameters.file', async () => {
      const reader = job.createReader(itemContext(csv(VALID_CSV)));
      await reader.open({ data: null, version: 0 });

      const row = await reader.read();
      expect(row).toEqual({
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: '9.99',
        category: 'books',
      });
    });

    test('returned reader tracks cursor state and writes checkpoints', async () => {
      const file = csv(`${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n2,Gadget,SKU-2,19.99,food\n`);
      const reader = job.createReader(itemContext(file, 'step-a'));
      await reader.open({ data: null, version: 0 });

      const r1 = await reader.read();
      const r2 = await reader.read();
      const updated = await reader.update({ data: null, version: 0 });
      const r3 = await reader.read();

      expect(r1?.id).toBe('1');
      expect(r2?.id).toBe('2');
      expect(updated.data).toEqual({ 'csvProductReader.index': 2 });
      expect(r3).toBeNull();
    });

    test('returned reader resumes from a checkpointed row index', async () => {
      const file = csv(`${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n2,Gadget,SKU-2,19.99,food\n`);
      const reader = job.createReader(itemContext(file, 'step-a'));
      await reader.open({ data: { 'csvProductReader.index': 1 }, version: 0 });

      const row = await reader.read();

      expect(row?.id).toBe('2');
    });

    test('factory creates separate readers for different job parameter files', async () => {
      const firstFile = csv(`${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n`);
      const secondFile = csv(`${VALID_HEADER}\n2,Gadget,SKU-2,19.99,food\n`);

      const firstReader = job.createReader(itemContext(firstFile, 'step-a'));
      const secondReader = job.createReader(itemContext(secondFile, 'step-b'));
      await firstReader.open({ data: null, version: 0 });
      await secondReader.open({ data: null, version: 0 });
      const r1 = await firstReader.read();
      const r2 = await secondReader.read();

      expect(r1?.id).toBe('1');
      expect(r2?.id).toBe('2');
    });
  });

  describe('process(item)', () => {
    test('delegates to the injected ProductProcessor and returns its result', async () => {
      const item: RawProductRow = {
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: '9.99',
        category: 'books',
      };
      const spy = vi.spyOn(processor, 'process');

      const entity = await job.process(item);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(item, undefined);
      expect(entity).toBeInstanceOf(ProductEntity);
      expect(entity).toMatchObject({
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: 9.99,
        category: 'books',
      });
    });

    test('propagates ProductProcessor errors', async () => {
      const item: RawProductRow = {
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: '9.99',
        category: 'unknown-category',
      };
      await expect(job.process(item)).rejects.toThrow(/Category must be one of/);
    });
  });

  describe('write(items)', () => {
    test('delegates to the injected ProductWriter and returns its result', async () => {
      const items: ProductEntity[] = [];
      const spy = vi.spyOn(writer, 'write').mockResolvedValue({ written: 0, skipped: 0 });

      const result = await job.write(items);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(items, undefined);
      expect(result).toEqual({ written: 0, skipped: 0 });
    });
  });
});
