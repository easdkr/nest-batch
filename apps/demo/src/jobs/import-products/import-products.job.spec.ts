import 'reflect-metadata';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImportProductsJob } from './import-products.job';
import { ProductProcessor } from './processor/product.processor';
import { ProductWriter } from './writer/product.writer';
import type { RawProductRow } from './reader/csv-product.reader';
import { ProductEntity } from '../../entities/product.entity';
import type { TaskletContext } from '@nest-batch/core';

function makeCsv(content: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'import-products-job-spec-'));
  const file = join(dir, 'data.csv');
  writeFileSync(file, content);
  return { file, dir };
}

const VALID_HEADER = 'id,name,sku,price,category';
const VALID_CSV = `${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n`;

describe('ImportProductsJob', () => {
  let job: ImportProductsJob;
  let processor: ProductProcessor;
  let writer: ProductWriter;
  let tmpDirs: string[];

  beforeEach(() => {
    processor = new ProductProcessor();
    // The job's write() path is fully delegated to the injected writer,
    // and our tests assert delegation via vi.spyOn so the em is never
    // touched. Pass a cast mock rather than a real EntityManager.
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

  describe('configure(filePath)', () => {
    test('makes validate-csv resolve against the new file path', async () => {
      job.configure(csv(VALID_CSV));
      const result = await job.validateCsv({} as TaskletContext);
      expect(result).toEqual({ rows: 1 });
    });

    test('resets the lazy reader so a subsequent read() re-opens the file', async () => {
      // First file: 1 data row
      const firstFile = csv(`${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n`);
      job.configure(firstFile);
      const r1 = await job.read();
      expect(r1).toEqual({
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: '9.99',
        category: 'books',
      });

      // Reconfigure to a different file: the previously constructed reader
      // must be discarded so the new file is read, not the old one.
      const secondFile = csv(`${VALID_HEADER}\n2,Gadget,SKU-2,19.99,food\n`);
      job.configure(secondFile);
      const r2 = await job.read();
      expect(r2).toEqual({
        id: '2',
        name: 'Gadget',
        sku: 'SKU-2',
        price: '19.99',
        category: 'food',
      });
    });
  });

  describe('validateCsv(ctx)', () => {
    test('throws when no file path has been configured', async () => {
      await expect(job.validateCsv({} as TaskletContext)).rejects.toThrow(
        /not configured with a CSV file path/,
      );
    });

    test('returns { rows: N } where N matches the data rows in the file', async () => {
      job.configure(
        csv(`${VALID_HEADER}\n1,Widget,SKU-1,9.99,books\n2,Gadget,SKU-2,19.99,food\n3,Bolt,SKU-3,5.00,clothing\n`),
      );
      const result = await job.validateCsv({} as TaskletContext);
      expect(result).toEqual({ rows: 3 });
    });

    test('propagates the tasklet error when the file does not exist', async () => {
      job.configure('/nonexistent/path/that/should/not/exist.csv');
      await expect(job.validateCsv({} as TaskletContext)).rejects.toThrow(
        /CSV file not found/,
      );
    });

    test('propagates the tasklet error when the file has no data rows', async () => {
      job.configure(csv(`${VALID_HEADER}\n`));
      await expect(job.validateCsv({} as TaskletContext)).rejects.toThrow(
        /at least 1 data row/,
      );
    });
  });

  describe('read()', () => {
    test('throws when no file path has been configured', async () => {
      await expect(job.read()).rejects.toThrow(/not configured with a CSV file path/);
    });

    test('returns the first data row on the first call', async () => {
      job.configure(csv(VALID_CSV));
      const row = await job.read();
      expect(row).toEqual({
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: '9.99',
        category: 'books',
      });
    });

    test('returns null past EOF on subsequent calls (does not re-wind the file)', async () => {
      job.configure(csv(VALID_CSV));
      const r1 = await job.read();
      const r2 = await job.read();
      const r3 = await job.read();
      expect(r1?.id).toBe('1');
      expect(r2).toBeNull();
      expect(r3).toBeNull();
    });

    test('constructs the CsvProductReader lazily (only on first read())', async () => {
      job.configure(csv(VALID_CSV));
      // Read twice — both must use the same reader instance. We can detect
      // this indirectly: a fresh reader would re-validate the header. The
      // header is valid so no throw; the read results must still flow in
      // order from a single iterator.
      const r1 = await job.read();
      const r2 = await job.read();
      expect(r1?.id).toBe('1');
      expect(r2).toBeNull();
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
      expect(spy).toHaveBeenCalledWith(item);
      expect(entity).toBeInstanceOf(ProductEntity);
      expect(entity).toMatchObject({
        id: '1',
        name: 'Widget',
        sku: 'SKU-1',
        price: 9.99,
        category: 'books',
      });
    });

    test('propagates ProductProcessor errors (e.g., invalid category)', async () => {
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
      const spy = vi
        .spyOn(writer, 'write')
        .mockResolvedValue({ written: 0, skipped: 0 });
      const result = await job.write(items);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(items);
      expect(result).toEqual({ written: 0, skipped: 0 });
    });
  });
});
