import { readFile } from 'node:fs/promises';

import type { ExecutionContext, ItemReader, ItemStream } from '../core';

import { readCheckpointNumber, writeCheckpoint } from './checkpoint';

export interface RestartableFileLineReaderOptions<T = string> {
  readonly path: string;
  readonly encoding?: BufferEncoding;
  readonly checkpointKey?: string;
  readonly skipLines?: number;
  readonly skipBlankLines?: boolean;
  readonly mapLine?: (line: string, lineIndex: number) => T | null | Promise<T | null>;
}

export class RestartableFileLineReader<T = string>
  implements ItemReader<T>, ItemStream
{
  private lines: string[] = [];
  private index = 0;

  constructor(private readonly options: RestartableFileLineReaderOptions<T>) {}

  async open(context: ExecutionContext): Promise<void> {
    const raw = await readFile(this.options.path, this.options.encoding ?? 'utf8');
    this.lines = splitLines(raw);
    this.index = readCheckpointNumber(
      context,
      this.checkpointKey,
      'index',
      this.options.skipLines ?? 0,
    );
  }

  async read(): Promise<T | null> {
    while (this.index < this.lines.length) {
      const lineIndex = this.index;
      const line = this.lines[this.index]!;
      this.index += 1;
      if (this.options.skipBlankLines === true && line.trim().length === 0) continue;
      if (this.options.mapLine !== undefined) {
        const mapped = await this.options.mapLine(line, lineIndex);
        if (mapped === null) continue;
        return mapped;
      }
      return line as T;
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
    return this.options.checkpointKey ?? `file-line:${this.options.path}`;
  }
}

export interface CsvFileItemReaderOptions<T extends Record<string, unknown>> {
  readonly path: string;
  readonly encoding?: BufferEncoding;
  readonly checkpointKey?: string;
  readonly delimiter?: string;
  readonly headers?: readonly string[];
  readonly hasHeader?: boolean;
  readonly skipBlankLines?: boolean;
  readonly mapRow?: (
    row: Record<string, string>,
    lineIndex: number,
  ) => T | null | Promise<T | null>;
}

export class CsvFileItemReader<T extends Record<string, unknown> = Record<string, string>>
  implements ItemReader<T>, ItemStream
{
  private lines: string[] = [];
  private headers: readonly string[] = [];
  private index = 0;

  constructor(private readonly options: CsvFileItemReaderOptions<T>) {}

  async open(context: ExecutionContext): Promise<void> {
    const raw = await readFile(this.options.path, this.options.encoding ?? 'utf8');
    this.lines = splitLines(raw);
    const hasHeader = this.options.hasHeader ?? this.options.headers === undefined;
    this.headers =
      this.options.headers ??
      (this.lines.length > 0
        ? parseDelimitedLine(this.lines[0]!, this.delimiter)
        : []);
    const firstDataLine = hasHeader ? 1 : 0;
    this.index = readCheckpointNumber(context, this.checkpointKey, 'index', firstDataLine);
  }

  async read(): Promise<T | null> {
    while (this.index < this.lines.length) {
      const lineIndex = this.index;
      const line = this.lines[this.index]!;
      this.index += 1;
      if (this.options.skipBlankLines !== false && line.trim().length === 0) continue;
      const fields = parseDelimitedLine(line, this.delimiter);
      const row: Record<string, string> = {};
      for (let i = 0; i < this.headers.length; i += 1) {
        row[this.headers[i]!] = fields[i] ?? '';
      }
      if (this.options.mapRow !== undefined) {
        const mapped = await this.options.mapRow(row, lineIndex);
        if (mapped === null) continue;
        return mapped;
      }
      return row as T;
    }
    return null;
  }

  update(context: ExecutionContext): ExecutionContext {
    return writeCheckpoint(context, this.checkpointKey, { index: this.index });
  }

  close(): void {
    this.lines = [];
    this.headers = [];
  }

  private get checkpointKey(): string {
    return this.options.checkpointKey ?? `csv:${this.options.path}`;
  }

  private get delimiter(): string {
    return this.options.delimiter ?? ',';
  }
}

export interface JsonlFileItemReaderOptions<T> {
  readonly path: string;
  readonly encoding?: BufferEncoding;
  readonly checkpointKey?: string;
}

export class JsonlFileItemReader<T = unknown> extends RestartableFileLineReader<T> {
  constructor(options: JsonlFileItemReaderOptions<T>) {
    super({
      ...options,
      skipBlankLines: true,
      mapLine: (line) => JSON.parse(line) as T,
    });
  }
}

export function splitLines(raw: string | Buffer): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function parseDelimitedLine(line: string, delimiter = ','): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}
