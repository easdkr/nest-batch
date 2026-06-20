import { describe, expect, test } from 'vitest';
import { EXECUTION_STRATEGY, EXTERNAL_TASK_LAUNCHER } from '@nest-batch/core';

import { KubernetesJobAdapter } from '../src/kubernetes-job.adapter';
import { KubernetesJobLauncher } from '../src/kubernetes-job-launcher';
import { KUBERNETES_JOB_MODULE_OPTIONS } from '../src/module-options';

describe('KubernetesJobAdapter', () => {
  test('builds a transport adapter with external task providers', () => {
    const adapter = KubernetesJobAdapter.forRoot({
      client: {
        async createJob() {
          return { name: 'batch-job' };
        },
      },
      namespace: 'batch',
      image: 'repo/app:latest',
    });

    expect(adapter.name).toBe('kubernetes-job');
    expect(adapter.module.providers).toEqual(
      expect.arrayContaining([
        KubernetesJobLauncher,
        expect.objectContaining({ provide: EXECUTION_STRATEGY }),
        expect.objectContaining({ provide: EXTERNAL_TASK_LAUNCHER }),
        expect.objectContaining({ provide: KUBERNETES_JOB_MODULE_OPTIONS }),
      ]),
    );
  });

  test('launcher builds a Kubernetes Job manifest', () => {
    const launcher = new KubernetesJobLauncher({
      client: {
        async createJob() {
          return { name: 'batch-job' };
        },
      },
      namespace: 'batch',
      image: 'repo/app:latest',
      jobNamePrefix: 'batch',
      containerName: 'worker',
      restartPolicy: 'Never',
    });

    const manifest = launcher.buildJobManifest({
      jobId: 'import-products',
      jobExecutionId: 'exec-1',
      params: {},
      workerArgs: ['batch-worker', '--job-execution-id', 'exec-1'],
      env: { NEST_BATCH_JOB_EXECUTION_ID: 'exec-1' },
      labels: { 'nest-batch/job-id': 'import-products' },
    });

    expect(manifest.metadata.name).toBe('batch-exec-1');
    expect(manifest.metadata.namespace).toBe('batch');
    expect(manifest.spec.template.spec.containers[0].image).toBe('repo/app:latest');
    expect(manifest.spec.template.spec.containers[0].args).toEqual([
      'batch-worker',
      '--job-execution-id',
      'exec-1',
    ]);
  });
});
