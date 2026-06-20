import { describe, expect, test } from 'vitest';

import type { ExecutionContext } from '../../src/core';
import {
  DatabaseBatchItemWriter,
  DatabaseCursorItemReader,
  DatabasePagingItemReader,
} from '../../src/io';

describe('database reader and writer helpers', () => {
  test('DatabasePagingItemReader resumes from offset checkpoint', async () => {
    const rows = [1, 2, 3, 4];
    const context: ExecutionContext = { data: null, version: 0 };
    const reader = new DatabasePagingItemReader<number>({
      pageSize: 2,
      fetchPage: async ({ offset, limit }) => rows.slice(offset, offset + limit),
    });

    reader.open(context);
    expect(await reader.read()).toBe(1);
    expect(await reader.read()).toBe(2);
    reader.update(context);

    const resumed = new DatabasePagingItemReader<number>({
      pageSize: 2,
      fetchPage: async ({ offset, limit }) => rows.slice(offset, offset + limit),
    });
    resumed.open(context);
    expect(await resumed.read()).toBe(3);
  });

  test('DatabaseCursorItemReader resumes after the last committed cursor', async () => {
    const rows = [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ];
    const context: ExecutionContext = { data: null, version: 0 };
    const makeReader = () =>
      new DatabaseCursorItemReader<{ id: number }>({
        pageSize: 2,
        initialCursor: 0,
        fetchAfter: async (cursor, limit) => {
          const numericCursor = typeof cursor === 'number' ? cursor : 0;
          return rows.filter((r) => r.id > numericCursor).slice(0, limit);
        },
        getCursor: (item) => item.id,
      });

    const reader = makeReader();
    reader.open(context);
    expect(await reader.read()).toEqual({ id: 1 });
    reader.update(context);

    const resumed = makeReader();
    resumed.open(context);
    expect(await resumed.read()).toEqual({ id: 2 });
  });

  test('DatabaseBatchItemWriter delegates the whole chunk', async () => {
    const written: number[] = [];
    const writer = new DatabaseBatchItemWriter<number>({
      writeBatch: async (items) => {
        written.push(...items);
        return { written: items.length, skipped: 0 };
      },
    });

    await expect(writer.write([1, 2, 3])).resolves.toEqual({
      written: 3,
      skipped: 0,
    });
    expect(written).toEqual([1, 2, 3]);
  });
});
