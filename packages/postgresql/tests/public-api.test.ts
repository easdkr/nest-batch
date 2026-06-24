import { describe, expect, it } from 'vitest';

import * as postgresql from '../src';

describe('@nest-batch/postgresql public API', () => {
  it('does not export MikroORM meta-entity classes or tuple', () => {
    expect(postgresql).not.toHaveProperty('BATCH_META_ENTITIES');
    expect(postgresql).not.toHaveProperty('JobInstanceEntity');
    expect(postgresql).not.toHaveProperty('JobExecutionEntity');
    expect(postgresql).not.toHaveProperty('StepExecutionEntity');
    expect(postgresql).not.toHaveProperty('JobExecutionContextEntity');
    expect(postgresql).not.toHaveProperty('StepExecutionContextEntity');
  });
});
