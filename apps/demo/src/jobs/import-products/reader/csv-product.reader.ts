import { Injectable } from '@nestjs/common';
import { ItemReader, ItemStream, type ExecutionContext } from '@nest-batch/core';
import { parse } from 'csv-parse';
import { readFileSync, createReadStream } from 'fs';
import { Readable } from 'stream';

const REQUIRED_COLUMNS = ['id', 'name', 'sku', 'price', 'category'];
const CHECKPOINT_KEY = 'csvProductReader.index';

export interface RawProductRow {
  id: string;
  name: string;
  sku: string;
  price: string;
  category: string;
}

@Injectable()
export class CsvProductReader implements ItemReader<RawProductRow>, ItemStream {
  private iterator: AsyncIterator<RawProductRow> | null = null;
  private finished = false;
  private currentIndex = 0;
  private resumeIndex = 0;

  constructor(private readonly filePath: string) {
    this.validateHeader(filePath);
  }

  private validateHeader(filePath: string): void {
    const content = readFileSync(filePath, 'utf8');
    const firstLine = content.split('\n')[0] ?? '';
    const headers = firstLine.split(',').map((h) => h.trim());
    for (const required of REQUIRED_COLUMNS) {
      if (!headers.includes(required)) {
        throw new Error(`Malformed CSV: missing column "${required}" in ${filePath}`);
      }
    }
  }

  async open(context: ExecutionContext): Promise<void> {
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    const index = (data as Record<string, unknown>)[CHECKPOINT_KEY];
    this.currentIndex = 0;
    this.resumeIndex = typeof index === 'number' && Number.isFinite(index) ? index : 0;
    this.iterator = null;
    this.finished = false;
  }

  async read(): Promise<RawProductRow | null> {
    if (this.finished) return null;
    if (!this.iterator) {
      const parser = createReadStream(this.filePath).pipe(
        parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }),
      );
      this.iterator = (parser as Readable)[Symbol.asyncIterator]();
    }

    while (this.currentIndex < this.resumeIndex) {
      const skipped = await this.iterator.next();
      if (skipped.done) {
        this.finished = true;
        return null;
      }
      this.currentIndex += 1;
    }

    const { value, done } = await this.iterator.next();
    if (done) {
      this.finished = true;
      return null;
    }
    this.currentIndex += 1;
    return value as RawProductRow;
  }

  async update(context: ExecutionContext): Promise<ExecutionContext> {
    const data =
      context.data !== null && typeof context.data === 'object' && !Array.isArray(context.data)
        ? context.data
        : {};
    return {
      ...context,
      data: {
        ...data,
        [CHECKPOINT_KEY]: this.currentIndex,
      },
    };
  }

  async close(): Promise<void> {
    this.iterator = null;
    this.finished = true;
  }
}
