import { SetMetadata } from '@nestjs/common';
import { BATCH_STEP_METADATA } from './constants';
import type { ChunkPartitionConfig, RetryPolicyConfig, SkipPolicyConfig } from '../core/ir';

export interface StepableOptions {
  id: string;
  chunkSize?: number; // 0 or undefined = tasklet step
  skipPolicy?: SkipPolicyConfig;
  retryPolicy?: RetryPolicyConfig;
  /**
   * Optional partition configuration forwarded to the compiled
   * `ChunkStepDefinition.partitions`. See `docs/RELEASE-0.2.0.md §6`
   * and `packages/core/src/partition-helpers.ts` for the contract.
   * Tasklet steps ignore this field.
   */
  partitions?: ChunkPartitionConfig;
}

/**
 * Method decorator that marks a method as a batch step.
 * When `chunkSize` is 0/undefined and `@Tasklet()` is also present, the step is a tasklet step.
 * Otherwise, the method must NOT be marked with `@Tasklet()` and step is a chunk step (uses the class-level reader/processor/writer).
 *
 * NOTE: The actual chunk step is assembled by the `DefinitionCompiler` from
 * class-level `@ItemReader`/`@ItemProcessor`/`@ItemWriter` methods.
 */
export function Stepable(options: StepableOptions): MethodDecorator {
  return SetMetadata(BATCH_STEP_METADATA, options);
}
