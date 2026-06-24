import { Injectable, Logger } from '@nestjs/common';
import { ItemReader, type ItemExecutionContext } from '@nest-batch/core';
import { parse } from 'csv-parse';
import { readFileSync, createReadStream } from 'fs';
import { Readable } from 'stream';

const REQUIRED_COLUMNS = ['id', 'name', 'sku', 'price', 'category'];

export interface RawProductRow {
  id: string;
  name: string;
  sku: string;
  price: string;
  category: string;
}

@Injectable()
export class CsvProductReader implements ItemReader<RawProductRow> {
  private readonly logger = new Logger(CsvProductReader.name);
  private iterator: AsyncIterator<RawProductRow> | null = null;
  private finished = false;

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

  async read(_ctx?: ItemExecutionContext): Promise<RawProductRow | null> {
    if (this.finished) return null;
    if (!this.iterator) {
      const parser = createReadStream(this.filePath).pipe(
        parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }),
      );
      this.iterator = (parser as Readable)[Symbol.asyncIterator]();
    }
    const { value, done } = await this.iterator.next();
    if (done) {
      this.finished = true;
      return null;
    }
    return value as RawProductRow;
  }
}
