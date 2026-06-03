import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SkipLoggerListener {
  private readonly logger = new Logger(SkipLoggerListener.name);

  async onSkipInRead(error: unknown, item: unknown): Promise<void> {
    this.logger.warn(`Skip read: ${(error as Error).message}`);
  }
  async onSkipInProcess(item: unknown, error: unknown): Promise<void> {
    this.logger.warn(`Skip process item=${JSON.stringify(item)}: ${(error as Error).message}`);
  }
  async onSkipInWrite(items: unknown[], error: unknown): Promise<void> {
    this.logger.warn(`Skip write ${items.length} items: ${(error as Error).message}`);
  }
}
