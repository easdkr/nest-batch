import { SetMetadata } from '@nestjs/common';
import { BATCH_JOB_METADATA } from './constants';

export interface JobableOptions {
  id: string;
  restartable?: boolean;
  allowDuplicateInstances?: boolean;
}

/**
 * Class decorator that marks a class as a batch job.
 * Metadata: { id, restartable, allowDuplicateInstances }
 */
export function Jobable(options: JobableOptions): ClassDecorator {
  return SetMetadata(BATCH_JOB_METADATA, options);
}
