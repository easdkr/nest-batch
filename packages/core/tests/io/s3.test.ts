import { describe, expect, test } from 'vitest';

import type { ExecutionContext } from '../../src/core';
import {
  S3ChunkJsonlItemWriter,
  S3JsonlItemReader,
  type S3ObjectClient,
  type S3PutObjectInput,
} from '../../src/io';

describe('S3 JSONL reader and writer', () => {
  test('S3JsonlItemReader resumes from checkpoint', async () => {
    const client: S3ObjectClient = {
      async getObject() {
        return { body: '{"id":1}\n{"id":2}\n' };
      },
      async putObject() {
        return undefined;
      },
    };
    const context: ExecutionContext = { data: null, version: 0 };
    const reader = new S3JsonlItemReader<{ id: number }>({
      client,
      bucket: 'bucket-a',
      key: 'input.jsonl',
    });

    await reader.open(context);
    expect(await reader.read()).toEqual({ id: 1 });
    reader.update(context);

    const resumed = new S3JsonlItemReader<{ id: number }>({
      client,
      bucket: 'bucket-a',
      key: 'input.jsonl',
    });
    await resumed.open(context);
    expect(await resumed.read()).toEqual({ id: 2 });
  });

  test('S3ChunkJsonlItemWriter writes deterministic chunk keys', async () => {
    const puts: S3PutObjectInput[] = [];
    const client: S3ObjectClient = {
      async getObject() {
        return { body: '' };
      },
      async putObject(input) {
        puts.push(input);
      },
    };
    const context: ExecutionContext = { data: null, version: 0 };
    const writer = new S3ChunkJsonlItemWriter<{ id: number }>({
      client,
      bucket: 'bucket-a',
      keyPrefix: 'runs/exec-1',
    });

    writer.open(context);
    await writer.write([{ id: 1 }]);
    writer.update(context);

    const resumed = new S3ChunkJsonlItemWriter<{ id: number }>({
      client,
      bucket: 'bucket-a',
      keyPrefix: 'runs/exec-1',
    });
    resumed.open(context);
    await resumed.write([{ id: 2 }]);

    expect(puts.map((p) => p.key)).toEqual([
      'runs/exec-1/chunk-000000.jsonl',
      'runs/exec-1/chunk-000001.jsonl',
    ]);
  });
});
