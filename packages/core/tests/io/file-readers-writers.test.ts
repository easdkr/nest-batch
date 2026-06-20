import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import type { ExecutionContext } from '../../src/core';
import {
  CsvFileItemReader,
  CsvFileItemWriter,
  JsonlFileItemReader,
  JsonlFileItemWriter,
  RestartableFileLineReader,
} from '../../src/io';

describe('file readers and writers', () => {
  test('RestartableFileLineReader resumes from the saved line index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nest-batch-file-reader-'));
    const path = join(dir, 'input.txt');
    await writeFile(path, 'a\nb\nc\n', 'utf8');
    const context: ExecutionContext = { data: null, version: 0 };

    const first = new RestartableFileLineReader({ path, skipBlankLines: true });
    await first.open(context);
    expect(await first.read()).toBe('a');
    expect(await first.read()).toBe('b');
    first.update(context);
    first.close();

    const resumed = new RestartableFileLineReader({ path, skipBlankLines: true });
    await resumed.open(context);
    expect(await resumed.read()).toBe('c');
    expect(await resumed.read()).toBeNull();
  });

  test('CsvFileItemReader maps rows and resumes from checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nest-batch-csv-reader-'));
    const path = join(dir, 'input.csv');
    await writeFile(path, 'sku,name\nA-1,Alpha\nB-2,\"Beta, Inc.\"\n', 'utf8');
    const context: ExecutionContext = { data: null, version: 0 };

    const reader = new CsvFileItemReader({ path });
    await reader.open(context);
    expect(await reader.read()).toEqual({ sku: 'A-1', name: 'Alpha' });
    reader.update(context);

    const resumed = new CsvFileItemReader({ path });
    await resumed.open(context);
    expect(await resumed.read()).toEqual({ sku: 'B-2', name: 'Beta, Inc.' });
  });

  test('JsonlFileItemReader parses JSON lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nest-batch-jsonl-reader-'));
    const path = join(dir, 'input.jsonl');
    await writeFile(path, '{"id":1}\n{"id":2}\n', 'utf8');
    const reader = new JsonlFileItemReader<{ id: number }>({ path });
    await reader.open({ data: null, version: 0 });

    expect(await reader.read()).toEqual({ id: 1 });
    expect(await reader.read()).toEqual({ id: 2 });
    expect(await reader.read()).toBeNull();
  });

  test('JsonlFileItemWriter and CsvFileItemWriter append chunk output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nest-batch-file-writer-'));
    const jsonlPath = join(dir, 'output.jsonl');
    const csvPath = join(dir, 'output.csv');

    await new JsonlFileItemWriter<{ id: number }>({ path: jsonlPath }).write([
      { id: 1 },
      { id: 2 },
    ]);
    expect(await readFile(jsonlPath, 'utf8')).toBe('{"id":1}\n{"id":2}\n');

    const context: ExecutionContext = { data: null, version: 0 };
    const writer = new CsvFileItemWriter<{ sku: string; name: string }>({
      path: csvPath,
      headers: ['sku', 'name'],
    });
    writer.open(context);
    await writer.write([{ sku: 'A-1', name: 'Alpha' }]);
    writer.update(context);

    const resumed = new CsvFileItemWriter<{ sku: string; name: string }>({
      path: csvPath,
      headers: ['sku', 'name'],
    });
    resumed.open(context);
    await resumed.write([{ sku: 'B-2', name: 'Beta, Inc.' }]);

    expect(await readFile(csvPath, 'utf8')).toBe(
      'sku,name\nA-1,Alpha\nB-2,"Beta, Inc."\n',
    );
  });
});
