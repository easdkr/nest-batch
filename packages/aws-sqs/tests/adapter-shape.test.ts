import { describe, expect, test } from 'vitest';
import { EXECUTION_STRATEGY, type JobDefinition } from '@nest-batch/core';

import { SqsAdapter } from '../src/sqs.adapter';
import { SqsExecutionStrategy } from '../src/sqs-execution-strategy';
import { AWS_SQS_MODULE_OPTIONS } from '../src/module-options';

const job = {
  id: 'import-products',
  steps: [],
  listeners: [],
  transitions: [],
  allowDuplicateInstances: false,
} as unknown as JobDefinition;

describe('SqsAdapter', () => {
  test('builds a transport adapter', () => {
    const adapter = SqsAdapter.forRoot({
      client: {
        async sendMessage() {
          return { MessageId: 'msg-1' };
        },
      },
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/batch.fifo',
    });

    expect(adapter.name).toBe('aws-sqs');
    expect(adapter.module.providers).toEqual(
      expect.arrayContaining([
        SqsExecutionStrategy,
        expect.objectContaining({ provide: EXECUTION_STRATEGY }),
        expect.objectContaining({ provide: AWS_SQS_MODULE_OPTIONS }),
      ]),
    );
  });

  test('strategy builds FIFO message metadata from execution context', () => {
    const strategy = new SqsExecutionStrategy({
      client: {
        async sendMessage() {
          return { MessageId: 'msg-1' };
        },
      },
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/batch.fifo',
      fifo: true,
      workerCommand: ['batch-worker'],
      messageAttributes: {},
    });

    const input = strategy.buildSendMessageInput(
      job,
      { limit: 10 },
      { executionId: 'exec-1', jobExecutionId: 'exec-1' },
    );

    expect(input.MessageGroupId).toBe('import-products');
    expect(input.MessageDeduplicationId).toBe('exec-1');
    expect(input.MessageAttributes?.jobExecutionId.StringValue).toBe('exec-1');
    expect(JSON.parse(input.MessageBody)).toMatchObject({
      version: 1,
      jobId: 'import-products',
      jobExecutionId: 'exec-1',
      params: { limit: 10 },
    });
  });
});
