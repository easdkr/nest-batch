import { describe, expect, test, vi } from 'vitest';
import { JobStatus, type JobDefinition } from '@nest-batch/core';

import { BatchAdminController } from '../src/batch-admin.controller';
import { renderBatchAdminHtml } from '../src/batch-admin.renderer';

const job = {
  id: 'import-products',
  startStepId: 'read',
  steps: { read: { id: 'read' } },
  transitions: [],
  listeners: [],
  restartable: false,
  allowDuplicateInstances: false,
} as unknown as JobDefinition;

describe('BatchAdminController', () => {
  test('dashboard renders jobs and executions as HTML', async () => {
    const controller = new BatchAdminController(
      {
        listJobs: () => [job],
        listJobExecutions: async () => [
          {
            id: 'exec-1',
            jobInstanceId: 'instance-1',
            status: JobStatus.COMPLETED,
            startTime: null,
            endTime: null,
            exitCode: 'COMPLETED',
            exitMessage: '',
            params: {},
          },
        ],
      } as never,
      {} as never,
    );

    const html = await controller.dashboard();
    expect(html).toContain('import-products');
    expect(html).toContain('exec-1');
  });

  test('operation endpoints delegate to JobOperator', async () => {
    const stop = vi.fn(async () => ({ ok: true }));
    const restart = vi.fn(async () => ({ ok: true }));
    const abandon = vi.fn(async () => ({ ok: true }));
    const startNextInstance = vi.fn(async () => ({ id: 'exec-2' }));
    const controller = new BatchAdminController(
      {
        listJobs: () => [],
        listJobExecutions: async () => [],
      } as never,
      { stop, restart, abandon, startNextInstance } as never,
    );

    await controller.stop('exec-1');
    await controller.restart('exec-1');
    await controller.abandon('exec-1');
    await controller.startNextInstance('job-a', { p: 1 });

    expect(stop).toHaveBeenCalledWith('exec-1');
    expect(restart).toHaveBeenCalledWith('exec-1');
    expect(abandon).toHaveBeenCalledWith('exec-1');
    expect(startNextInstance).toHaveBeenCalledWith('job-a', { p: 1 });
  });
});

describe('renderBatchAdminHtml', () => {
  test('escapes user controlled fields', () => {
    const html = renderBatchAdminHtml({
      jobs: [{ ...job, id: '<script>' }],
      executions: [],
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
