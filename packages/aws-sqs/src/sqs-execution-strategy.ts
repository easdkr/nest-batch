import { Inject, Injectable } from '@nestjs/common';
import type {
  ExecutionStrategyContext,
  IExecutionStrategy,
  JobDefinition,
  JobParameters,
  LaunchResult,
} from '@nest-batch/core';

import {
  AWS_SQS_MODULE_OPTIONS,
  type ResolvedSqsModuleOptions,
  type SqsBatchMessage,
  type SqsMessageAttributeValue,
  type SqsMessageKeyContext,
  type SqsSendMessageInput,
} from './module-options';

export const SQS_STRATEGY_NAME = 'aws-sqs';

@Injectable()
export class SqsExecutionStrategy implements IExecutionStrategy {
  readonly name = SQS_STRATEGY_NAME;

  constructor(
    @Inject(AWS_SQS_MODULE_OPTIONS)
    private readonly options: ResolvedSqsModuleOptions,
  ) {}

  async launch(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): Promise<LaunchResult> {
    const input = this.buildSendMessageInput(job, params, ctx);
    const output = await this.options.client.sendMessage(input);
    return {
      kind: 'enqueued',
      queueJobId: `sqs:${output.MessageId ?? ctx.jobExecutionId}`,
    };
  }

  buildSendMessageInput(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): SqsSendMessageInput {
    const keyContext: SqsMessageKeyContext = { job, params, ctx };
    const message = this.buildMessage(job, params, ctx);
    const attributes: Record<string, SqsMessageAttributeValue> = {
      ...stringAttributes(this.options.messageAttributes),
      jobId: { DataType: 'String', StringValue: job.id },
      jobExecutionId: { DataType: 'String', StringValue: ctx.jobExecutionId },
    };

    return {
      QueueUrl: this.options.queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: attributes,
      ...(this.options.delaySeconds !== undefined
        ? { DelaySeconds: this.options.delaySeconds }
        : {}),
      ...(this.options.fifo
        ? {
            MessageGroupId:
              this.resolveKey(this.options.messageGroupId, keyContext) ?? job.id,
            MessageDeduplicationId:
              this.resolveKey(this.options.messageDeduplicationId, keyContext) ??
              ctx.jobExecutionId,
          }
        : {}),
    };
  }

  private buildMessage(
    job: JobDefinition,
    params: JobParameters,
    ctx: ExecutionStrategyContext,
  ): SqsBatchMessage {
    return {
      version: 1,
      jobId: job.id,
      executionId: ctx.executionId,
      jobExecutionId: ctx.jobExecutionId,
      params,
      workerArgs: [
        ...this.options.workerCommand,
        '--job-id',
        job.id,
        '--job-execution-id',
        ctx.jobExecutionId,
        '--params-json',
        JSON.stringify(params),
      ],
      sentAt: new Date().toISOString(),
    };
  }

  private resolveKey(
    value: ResolvedSqsModuleOptions['messageGroupId'],
    context: SqsMessageKeyContext,
  ): string | undefined {
    if (typeof value === 'function') return value(context);
    return value;
  }
}

function stringAttributes(
  attributes: Readonly<Record<string, string>>,
): Record<string, SqsMessageAttributeValue> {
  const out: Record<string, SqsMessageAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = { DataType: 'String', StringValue: value };
  }
  return out;
}
