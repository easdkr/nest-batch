import { Tasklet, TaskletContext } from '@nest-batch/core';
import { existsSync, readFileSync } from 'fs';

export class ValidateCsvTasklet implements Tasklet {
  constructor(private readonly filePath: string) {}

  async execute(_ctx: TaskletContext): Promise<{ rows: number }> {
    if (!existsSync(this.filePath)) {
      throw new Error(`CSV file not found: ${this.filePath}`);
    }
    const content = readFileSync(this.filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) {
      throw new Error('CSV must have at least 1 data row');
    }
    return { rows: lines.length - 1 };
  }
}
