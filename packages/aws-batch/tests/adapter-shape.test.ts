import { describe, expect, test } from 'vitest';
import { EXECUTION_STRATEGY, EXTERNAL_TASK_LAUNCHER } from '@nest-batch/core';

import { AwsBatchAdapter } from '../src/aws-batch.adapter';
import { AwsBatchJobLauncher } from '../src/aws-batch-job-launcher';
import { AWS_BATCH_MODULE_OPTIONS } from '../src/module-options';

describe('AwsBatchAdapter', () => {
  test('builds a transport adapter with external task providers', () => {
    const adapter = AwsBatchAdapter.forRoot({
      client: {
        async submitJob() {
          return { jobId: 'job-1' };
        },
      },
      jobQueue: 'queue-a',
      jobDefinition: 'definition-a',
    });

    expect(adapter.name).toBe('aws-batch');
    expect(adapter.module.providers).toEqual(
      expect.arrayContaining([
        AwsBatchJobLauncher,
        expect.objectContaining({ provide: EXECUTION_STRATEGY }),
        expect.objectContaining({ provide: EXTERNAL_TASK_LAUNCHER }),
        expect.objectContaining({ provide: AWS_BATCH_MODULE_OPTIONS }),
      ]),
    );
  });

  test('launcher maps worker metadata to SubmitJob input', () => {
    const launcher = new AwsBatchJobLauncher({
      client: {
        async submitJob() {
          return { jobId: 'job-1' };
        },
      },
      jobQueue: 'queue-a',
      jobDefinition: 'definition-a',
      jobNamePrefix: 'batch',
      parameters: {},
      tags: {},
    });

    const input = launcher.buildSubmitJobInput({
      jobId: 'import-products',
      jobExecutionId: 'exec-1',
      params: {},
      workerArgs: ['batch-worker', '--job-execution-id', 'exec-1'],
      env: { NEST_BATCH_JOB_EXECUTION_ID: 'exec-1' },
      labels: { 'nest-batch/job-id': 'import-products' },
    });

    expect(input.jobName).toBe('batch-exec-1');
    expect(input.jobQueue).toBe('queue-a');
    expect(input.containerOverrides?.command).toEqual([
      'batch-worker',
      '--job-execution-id',
      'exec-1',
    ]);
    expect(input.parameters).toMatchObject({
      jobId: 'import-products',
      jobExecutionId: 'exec-1',
    });
  });
});
