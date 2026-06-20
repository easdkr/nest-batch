import type { ExecutionStrategyContext, JobDefinition, JobParameters } from '@nest-batch/core';

export const AWS_SQS_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/aws-sqs/AWS_SQS_MODULE_OPTIONS',
);

export interface SqsMessageAttributeValue {
  readonly DataType: 'String';
  readonly StringValue: string;
}

export interface SqsSendMessageInput {
  readonly QueueUrl: string;
  readonly MessageBody: string;
  readonly MessageAttributes?: Readonly<Record<string, SqsMessageAttributeValue>>;
  readonly MessageGroupId?: string;
  readonly MessageDeduplicationId?: string;
  readonly DelaySeconds?: number;
}

export interface SqsSendMessageOutput {
  readonly MessageId?: string;
  readonly SequenceNumber?: string;
}

export interface SqsSendMessageClient {
  sendMessage(input: SqsSendMessageInput): Promise<SqsSendMessageOutput>;
}

export interface SqsBatchMessage {
  readonly version: 1;
  readonly jobId: string;
  readonly executionId: string;
  readonly jobExecutionId: string;
  readonly params: JobParameters;
  readonly workerArgs: readonly string[];
  readonly sentAt: string;
}

export interface SqsMessageKeyContext {
  readonly job: JobDefinition;
  readonly params: JobParameters;
  readonly ctx: ExecutionStrategyContext;
}

export interface SqsModuleOptions {
  readonly client: SqsSendMessageClient;
  readonly queueUrl: string;
  readonly fifo?: boolean;
  readonly delaySeconds?: number;
  readonly workerCommand?: readonly string[];
  readonly messageGroupId?: string | ((context: SqsMessageKeyContext) => string);
  readonly messageDeduplicationId?: string | ((context: SqsMessageKeyContext) => string);
  readonly messageAttributes?: Readonly<Record<string, string>>;
}

export interface ResolvedSqsModuleOptions {
  readonly client: SqsSendMessageClient;
  readonly queueUrl: string;
  readonly fifo: boolean;
  readonly delaySeconds?: number;
  readonly workerCommand: readonly string[];
  readonly messageGroupId?: string | ((context: SqsMessageKeyContext) => string);
  readonly messageDeduplicationId?: string | ((context: SqsMessageKeyContext) => string);
  readonly messageAttributes: Readonly<Record<string, string>>;
}

export function resolveSqsOptions(options: SqsModuleOptions): ResolvedSqsModuleOptions {
  return Object.freeze({
    client: options.client,
    queueUrl: options.queueUrl,
    fifo: options.fifo ?? options.queueUrl.endsWith('.fifo'),
    ...(options.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}),
    workerCommand: Object.freeze([...(options.workerCommand ?? ['batch-worker'])]),
    ...(options.messageGroupId !== undefined
      ? { messageGroupId: options.messageGroupId }
      : {}),
    ...(options.messageDeduplicationId !== undefined
      ? { messageDeduplicationId: options.messageDeduplicationId }
      : {}),
    messageAttributes: Object.freeze({ ...(options.messageAttributes ?? {}) }),
  });
}
