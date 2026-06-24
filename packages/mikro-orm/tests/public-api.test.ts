import { describe, expect, it } from 'vitest';

import {
  BATCH_META_ENTITIES,
  JobExecutionContextEntity,
  JobExecutionEntity,
  JobInstanceEntity,
  StepExecutionContextEntity,
  StepExecutionEntity,
} from '../src';

describe('@nest-batch/mikro-orm public API', () => {
  it('exports the active 5-table MikroORM meta-entity tuple', () => {
    expect(BATCH_META_ENTITIES).toEqual([
      JobInstanceEntity,
      JobExecutionEntity,
      StepExecutionEntity,
      JobExecutionContextEntity,
      StepExecutionContextEntity,
    ]);
    expect(BATCH_META_ENTITIES).toHaveLength(5);
    expect(BATCH_META_ENTITIES.map((entity) => entity.name)).not.toContain(
      'JobExecutionParamsEntity',
    );
  });
});
