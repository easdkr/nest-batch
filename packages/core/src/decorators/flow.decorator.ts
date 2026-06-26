import { SetMetadata } from '@nestjs/common';
import { BATCH_TRANSITION_METADATA } from './constants';
import type { FlowExecutionStatus } from '../core/status';

export interface OnTransitionOptions {
  fromStep: string;
  onStatus: FlowExecutionStatus | string; // string allowed for enum name lookup
  toStep: string | null;
}

/**
 * Declarative flow transition. The decorated method is a marker; the
 * compiler reads its metadata to build a `TransitionDefinition`.
 *
 * Usage:
 * ```typescript
 * @Jobable({ id: 'my-job' })
 * class MyJob {
 *   @Stepable({ id: 'step1' }) @Tasklet() async step1() {}
 *   @Stepable({ id: 'recovery' }) @Tasklet() async recovery() {}
 *
 *   @OnTransition({ fromStep: 'step1', onStatus: 'FAILED', toStep: 'recovery' })
 *   onFail() {}
 * }
 * ```
 */
export function OnTransition(options: OnTransitionOptions): MethodDecorator {
  return SetMetadata(BATCH_TRANSITION_METADATA, options);
}
