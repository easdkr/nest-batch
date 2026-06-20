import { describe, expect, it, vi } from 'vitest';

import { RefKind, type JobDefinition } from '../../src/core/ir';
import {
  ExternalTaskExecutionStrategy,
  type ExternalTaskLaunchRequest,
} from '../../src/execution/external-task-execution-strategy';

function makeJob(id: string): JobDefinition {
  return {
    id,
    steps: {
      s1: {
        kind: 'tasklet',
        id: 's1',
        tasklet: { kind: RefKind.BuilderLambda, fn: async () => 'ok' },
        listeners: [],
      },
    },
    startStepId: 's1',
    transitions: [],
    listeners: [],
    restartable: false,
    allowDuplicateInstances: false,
  };
}

describe('ExternalTaskExecutionStrategy', () => {
  it('launches a one-off worker request and returns an enqueued result', async () => {
    const requests: ExternalTaskLaunchRequest[] = [];
    const launcher = {
      name: 'test-one-off',
      launch: vi.fn(async (request: ExternalTaskLaunchRequest) => {
        requests.push(request);
        return {
          provider: 'test',
          externalId: 'task-1',
        };
      }),
    };
    const strategy = new ExternalTaskExecutionStrategy(launcher, {
      workerCommand: ['node', 'dist/main.js', 'batch-worker'],
      env: { NODE_ENV: 'test' },
      labels: { owner: 'batch' },
    });

    const result = await strategy.launch(
      makeJob('nightly'),
      { tenantId: 'a' },
      { executionId: 'exec-1', jobExecutionId: 'exec-1' },
    );

    expect(result).toEqual({ kind: 'enqueued', queueJobId: 'test:task-1' });
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(requests[0]).toEqual({
      jobId: 'nightly',
      jobExecutionId: 'exec-1',
      params: { tenantId: 'a' },
      workerArgs: [
        'node',
        'dist/main.js',
        'batch-worker',
        '--job-id',
        'nightly',
        '--job-execution-id',
        'exec-1',
        '--params-json',
        '{"tenantId":"a"}',
      ],
      env: {
        NODE_ENV: 'test',
        NEST_BATCH_JOB_ID: 'nightly',
        NEST_BATCH_JOB_EXECUTION_ID: 'exec-1',
      },
      labels: {
        owner: 'batch',
        'nest-batch/job-id': 'nightly',
        'nest-batch/job-execution-id': 'exec-1',
      },
    });
  });
});
