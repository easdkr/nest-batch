import { describe, expect, test } from 'vitest';
import {
  EXECUTION_STRATEGY,
  EXTERNAL_TASK_LAUNCHER,
  EXTERNAL_TASK_STRATEGY_OPTIONS,
} from '@nest-batch/core';

import { EcsFargateAdapter } from '../src/ecs-fargate.adapter';
import { EcsFargateTaskLauncher } from '../src/ecs-fargate-task-launcher';
import { ECS_FARGATE_MODULE_OPTIONS } from '../src/module-options';

describe('EcsFargateAdapter', () => {
  test('builds a transport adapter with external task providers', () => {
    const adapter = EcsFargateAdapter.forRoot({
      client: {
        async runTask() {
          return { tasks: [{ taskArn: 'arn:aws:ecs:task/1' }] };
        },
      },
      cluster: 'cluster-a',
      taskDefinition: 'task-def:1',
      containerName: 'worker',
      networkConfiguration: { subnets: ['subnet-a'] },
    });

    expect(adapter.name).toBe('aws-ecs-fargate');
    expect(adapter.module.providers).toEqual(
      expect.arrayContaining([
        EcsFargateTaskLauncher,
        expect.objectContaining({ provide: EXECUTION_STRATEGY }),
        expect.objectContaining({ provide: EXTERNAL_TASK_LAUNCHER }),
        expect.objectContaining({ provide: EXTERNAL_TASK_STRATEGY_OPTIONS }),
        expect.objectContaining({ provide: ECS_FARGATE_MODULE_OPTIONS }),
      ]),
    );
  });

  test('launcher maps worker metadata to RunTask input', () => {
    const launcher = new EcsFargateTaskLauncher({
      client: {
        async runTask() {
          return { tasks: [{ taskArn: 'arn:aws:ecs:task/1' }] };
        },
      },
      cluster: 'cluster-a',
      taskDefinition: 'task-def:1',
      containerName: 'worker',
      networkConfiguration: {
        subnets: ['subnet-a'],
        assignPublicIp: 'DISABLED',
      },
      enableExecuteCommand: false,
      tags: [],
    });

    const input = launcher.buildRunTaskInput({
      jobId: 'import-products',
      jobExecutionId: 'exec-1',
      params: { limit: 10 },
      workerArgs: ['batch-worker', '--job-id', 'import-products'],
      env: { NEST_BATCH_JOB_ID: 'import-products' },
      labels: { 'nest-batch/job-execution-id': 'exec-1' },
    });

    expect(input.cluster).toBe('cluster-a');
    expect(input.overrides.containerOverrides[0].command).toEqual([
      'batch-worker',
      '--job-id',
      'import-products',
    ]);
    expect(input.overrides.containerOverrides[0].environment).toContainEqual({
      name: 'NEST_BATCH_JOB_ID',
      value: 'import-products',
    });
    expect(input.tags).toContainEqual({
      key: 'nest-batch/job-execution-id',
      value: 'exec-1',
    });
  });
});
