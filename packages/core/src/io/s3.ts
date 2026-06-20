import type { ExecutionContext, ItemReader, ItemStream, ItemWriter } from '../core';

import { readCheckpointNumber, writeCheckpoint } from './checkpoint';
import { splitLines } from './file-readers';

export interface S3ObjectLocation {
  readonly bucket: string;
  readonly key: string;
}

export interface S3GetObjectInput extends S3ObjectLocation {}

export interface S3PutObjectInput extends S3ObjectLocation {
  readonly body: string | Uint8Array;
  readonly contentType?: string;
}

export interface S3ObjectClient {
  getObject(input: S3GetObjectInput): Promise<{ readonly body: string | Uint8Array }>;
  putObject(input: S3PutObjectInput): Promise<void>;
}

export interface S3JsonlItemReaderOptions<T> extends S3ObjectLocation {
  readonly client: S3ObjectClient;
  readonly checkpointKey?: string;
  readonly mapItem?: (item: unknown, lineIndex: number) => T | Promise<T>;
}

export class S3JsonlItemReader<T = unknown> implements ItemReader<T>, ItemStream {
  private lines: string[] = [];
  private index = 0;

  constructor(private readonly options: S3JsonlItemReaderOptions<T>) {}

  async open(context: ExecutionContext): Promise<void> {
    const object = await this.options.client.getObject({
      bucket: this.options.bucket,
      key: this.options.key,
    });
    this.lines = splitLines(bodyToString(object.body));
    this.index = readCheckpointNumber(context, this.checkpointKey, 'index', 0);
  }

  async read(): Promise<T | null> {
    while (this.index < this.lines.length) {
      const lineIndex = this.index;
      const line = this.lines[this.index]!;
      this.index += 1;
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as unknown;
      return this.options.mapItem !== undefined
        ? this.options.mapItem(parsed, lineIndex)
        : (parsed as T);
    }
    return null;
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, { index: this.index });
  }

  close(): void {
    this.lines = [];
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? `s3-jsonl:${this.options.bucket}/${this.options.key}`;
  }
}

export interface S3ChunkJsonlItemWriterOptions {
  readonly client: S3ObjectClient;
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly checkpointKey?: string;
}

export class S3ChunkJsonlItemWriter<T = unknown> implements ItemWriter<T>, ItemStream {
  private chunkIndex = 0;

  constructor(private readonly options: S3ChunkJsonlItemWriterOptions) {}

  open(context: ExecutionContext): void {
    this.chunkIndex = readCheckpointNumber(context, this.checkpointKey, 'chunkIndex', 0);
  }

  async write(items: T[]): Promise<void> {
    if (items.length === 0) return;
    const key = `${this.options.keyPrefix.replace(/\/+$/g, '')}/chunk-${String(this.chunkIndex).padStart(6, '0')}.jsonl`;
    const body = `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
    await this.options.client.putObject({
      bucket: this.options.bucket,
      key,
      body,
      contentType: 'application/x-ndjson',
    });
    this.chunkIndex += 1;
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, {
      chunkIndex: this.chunkIndex,
    });
  }

  close(): void {
    return undefined;
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? `s3-jsonl-writer:${this.options.bucket}/${this.options.keyPrefix}`;
  }
}

function bodyToString(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
}
