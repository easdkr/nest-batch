import { describe, expect, test } from 'vitest';
import { CsvProductReader } from './csv-product.reader';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CsvProductReader', () => {
  function makeCsv(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'csv-'));
    const file = join(dir, 'data.csv');
    writeFileSync(file, content);
    return file;
  }

  test('reads 3 rows from valid CSV', async () => {
    const file = makeCsv(
      'id,name,sku,price,category\n1,W,SKU-1,9.99,books\n2,G,SKU-2,19.99,food\n3,B,SKU-3,5.00,clothing\n',
    );
    const reader = new CsvProductReader(file);
    const r1 = await reader.read();
    expect(r1).toEqual({ id: '1', name: 'W', sku: 'SKU-1', price: '9.99', category: 'books' });
    const r2 = await reader.read();
    expect(r2?.id).toBe('2');
    const r3 = await reader.read();
    expect(r3?.id).toBe('3');
    const r4 = await reader.read();
    expect(r4).toBeNull();
  });

  test('malformed CSV throws on init', () => {
    const file = makeCsv('id,name,sku,price\n1,W,SKU-1,9.99\n');
    expect(() => new CsvProductReader(file)).toThrow(/missing column/);
  });

  test('empty CSV returns null immediately', async () => {
    const file = makeCsv('id,name,sku,price,category\n');
    const reader = new CsvProductReader(file);
    expect(await reader.read()).toBeNull();
  });

  test('BOM character is handled in header', async () => {
    const bom = '﻿';
    const file = makeCsv(
      bom + 'id,name,sku,price,category\n10,Widget,SKU-10,1.50,books\n20,Gadget,SKU-20,2.50,food\n',
    );
    const reader = new CsvProductReader(file);
    const r1 = await reader.read();
    expect(r1).toEqual({
      id: '10',
      name: 'Widget',
      sku: 'SKU-10',
      price: '1.50',
      category: 'books',
    });
  });

  test('read() past EOF is sticky — never rewinds the file (regression: infinite chunk loop)', async () => {
    const file = makeCsv(
      'id,name,sku,price,category\n1,W,SKU-1,9.99,books\n2,G,SKU-2,19.99,food\n',
    );
    const reader = new CsvProductReader(file);
    expect((await reader.read())?.id).toBe('1');
    expect((await reader.read())?.id).toBe('2');
    expect(await reader.read()).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(await reader.read()).toBeNull();
    }
  });

  test('open/update restore and persist row index checkpoints', async () => {
    const file = makeCsv(
      'id,name,sku,price,category\n1,W,SKU-1,9.99,books\n2,G,SKU-2,19.99,food\n3,B,SKU-3,5.00,clothing\n',
    );
    const reader = new CsvProductReader(file);

    await reader.open({ data: { 'csvProductReader.index': 1 }, version: 0 });
    expect((await reader.read())?.id).toBe('2');
    const updated = await reader.update({ data: { lastChunkIndex: 0 }, version: 0 });
    expect(updated.data).toEqual({ lastChunkIndex: 0, 'csvProductReader.index': 2 });
    expect((await reader.read())?.id).toBe('3');
  });
});
