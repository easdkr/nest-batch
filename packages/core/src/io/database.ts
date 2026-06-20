import type { ExecutionContext, ItemReader, ItemStream, ItemWriter, WriterResult } from '../core';
import type { JsonValue } from '../core/execution-context';

import { readCheckpointNumber, readCheckpointValue, writeCheckpoint } from './checkpoint';

export interface DatabasePagingItemReaderOptions<T> {
  readonly pageSize: number;
  readonly checkpointKey?: string;
  fetchPage(args: { offset: number; limit: number }): Promise<readonly T[]>;
}

export class DatabasePagingItemReader<T> implements ItemReader<T>, ItemStream {
  private offset = 0;
  private buffer: readonly T[] = [];
  private bufferIndex = 0;

  constructor(private readonly options: DatabasePagingItemReaderOptions<T>) {}

  open(context: ExecutionContext): void {
    this.offset = readCheckpointNumber(context, this.checkpointKey, 'offset', 0);
    this.buffer = [];
    this.bufferIndex = 0;
  }

  async read(): Promise<T | null> {
    if (this.bufferIndex >= this.buffer.length) {
      this.buffer = await this.options.fetchPage({
        offset: this.offset,
        limit: this.options.pageSize,
      });
      this.bufferIndex = 0;
      if (this.buffer.length === 0) return null;
    }
    const item = this.buffer[this.bufferIndex]!;
    this.bufferIndex += 1;
    this.offset += 1;
    return item;
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, { offset: this.offset });
  }

  close(): void {
    this.buffer = [];
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? 'database-paging-reader';
  }
}

export interface DatabaseCursorItemReaderOptions<T> {
  readonly pageSize: number;
  readonly checkpointKey?: string;
  readonly initialCursor?: JsonValue;
  fetchAfter(cursor: JsonValue, limit: number): Promise<readonly T[]>;
  getCursor(item: T): JsonValue;
}

export class DatabaseCursorItemReader<T> implements ItemReader<T>, ItemStream {
  private cursor: JsonValue = null;
  private buffer: readonly T[] = [];
  private bufferIndex = 0;

  constructor(private readonly options: DatabaseCursorItemReaderOptions<T>) {}

  open(context: ExecutionContext): void {
    this.cursor = readCheckpointValue(
      context,
      this.checkpointKey,
      'cursor',
      this.options.initialCursor ?? null,
    );
    this.buffer = [];
    this.bufferIndex = 0;
  }

  async read(): Promise<T | null> {
    if (this.bufferIndex >= this.buffer.length) {
      this.buffer = await this.options.fetchAfter(this.cursor, this.options.pageSize);
      this.bufferIndex = 0;
      if (this.buffer.length === 0) return null;
    }
    const item = this.buffer[this.bufferIndex]!;
    this.bufferIndex += 1;
    this.cursor = this.options.getCursor(item);
    return item;
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, { cursor: this.cursor });
  }

  close(): void {
    this.buffer = [];
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? 'database-cursor-reader';
  }
}

export interface DatabaseBatchItemWriterOptions<T> {
  writeBatch(items: readonly T[]): Promise<WriterResult | void>;
}

export class DatabaseBatchItemWriter<T> implements ItemWriter<T> {
  constructor(private readonly options: DatabaseBatchItemWriterOptions<T>) {}

  write(items: T[]): Promise<WriterResult | void> {
    return this.options.writeBatch(items);
  }
}
