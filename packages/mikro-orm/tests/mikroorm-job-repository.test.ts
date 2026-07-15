import { EntityManager, RequestContext } from '@mikro-orm/core';
import { StepStatus } from '@nest-batch/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepExecutionEntity } from '../src/entities/job-meta.entities';
import { MikroORMJobRepository } from '../src/mikroorm-job-repository';

describe('MikroORMJobRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a step execution from the write connection before updating it', async () => {
    const step = new StepExecutionEntity();
    step.id = 'step-1';
    step.status = StepStatus.STARTING;

    const em = {
      findOne: vi.fn().mockResolvedValue(step),
      flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as EntityManager;

    vi.spyOn(RequestContext, 'create').mockImplementation(((
      _em: EntityManager,
      callback: () => Promise<unknown>,
    ) => callback()) as typeof RequestContext.create);

    const repository = new MikroORMJobRepository(em);

    await repository.updateStepExecution('step-1', { status: StepStatus.COMPLETED });

    expect(em.findOne).toHaveBeenCalledWith(
      StepExecutionEntity,
      { id: 'step-1' },
      { connectionType: 'write' },
    );
    expect(step.status).toBe(StepStatus.COMPLETED);
    expect(em.flush).toHaveBeenCalledOnce();
  });
});
