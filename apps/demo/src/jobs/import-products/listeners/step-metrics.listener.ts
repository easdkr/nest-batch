import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StepMetricsListener {
  private readonly logger = new Logger(StepMetricsListener.name);
  private startTimes = new Map<string, number>();

  async beforeStep(ctx: { stepExecutionId: string }): Promise<void> {
    this.startTimes.set(ctx.stepExecutionId, Date.now());
  }
  async afterStep(
    ctx: { stepExecutionId: string },
    result: { status: string; readCount?: number; writeCount?: number; skipCount?: number },
  ): Promise<void> {
    const start = this.startTimes.get(ctx.stepExecutionId);
    const duration = start ? Date.now() - start : 0;
    this.logger.log(
      `Step ${ctx.stepExecutionId}: ${result.status} in ${duration}ms (read=${result.readCount ?? 0}, write=${result.writeCount ?? 0}, skip=${result.skipCount ?? 0})`,
    );
  }
}
