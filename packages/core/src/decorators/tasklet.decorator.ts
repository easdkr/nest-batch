import { SetMetadata } from '@nestjs/common';
import { BATCH_TASKLET_METADATA } from './constants';

export interface TaskletMetadata {
  kind: 'tasklet';
}

/**
 * Method decorator that marks a `@Stepable` method as a tasklet handler
 * (single execution, not a chunk loop).
 */
export function Tasklet(): MethodDecorator {
  return SetMetadata(BATCH_TASKLET_METADATA, { kind: 'tasklet' } satisfies TaskletMetadata);
}
