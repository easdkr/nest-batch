import { appendFile } from 'node:fs/promises';

import type { ExecutionContext, ItemStream, ItemWriter, WriterResult } from '../core';

import { readCheckpointValue, writeCheckpoint } from './checkpoint';
import { parseDelimitedLine } from './file-readers';

export interface JsonlFileItemWriterOptions {
  readonly path: string;
  readonly encoding?: BufferEncoding;
}

export class JsonlFileItemWriter<T = unknown> implements ItemWriter<T> {
  constructor(private readonly options: JsonlFileItemWriterOptions) {}

  async write(items: T[]): Promise<void> {
    if (items.length === 0) return;
    const body = `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
    await appendFile(this.options.path, body, this.options.encoding ?? 'utf8');
  }
}

export interface CsvFileItemWriterOptions<T extends Record<string, unknown>> {
  readonly path: string;
  readonly headers: readonly (keyof T & string)[];
  readonly encoding?: BufferEncoding;
  readonly delimiter?: string;
  readonly checkpointKey?: string;
  readonly writeHeader?: boolean;
}

export class CsvFileItemWriter<T extends Record<string, unknown>>
  implements ItemWriter<T>, ItemStream
{
  private headerWritten = false;

  constructor(private readonly options: CsvFileItemWriterOptions<T>) {}

  open(context: ExecutionContext): void {
    this.headerWritten = readCheckpointValue(
      context,
      this.checkpointKey,
      'headerWritten',
      false,
    );
  }

  async write(items: T[]): Promise<WriterResult | void> {
    if (items.length === 0) return;
    const lines: string[] = [];
    if ((this.options.writeHeader ?? true) && !this.headerWritten) {
      lines.push(this.options.headers.map((h) => escapeCsvValue(h, this.delimiter)).join(this.delimiter));
      this.headerWritten = true;
    }
    for (const item of items) {
      lines.push(
        this.options.headers
          .map((h) => escapeCsvValue(item[h], this.delimiter))
          .join(this.delimiter),
      );
    }
    await appendFile(
      this.options.path,
      `${lines.join('\n')}\n`,
      this.options.encoding ?? 'utf8',
    );
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, {
      headerWritten: this.headerWritten,
    });
  }

  close(): void {
    return undefined;
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? `csv-writer:${this.options.path}`;
  }

  private get delimiter(): string {
    return this.options.delimiter ?? ',';
  }
}

export function escapeCsvValue(value: unknown, delimiter = ','): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    parseDelimitedLine(text, delimiter).length > 1
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
