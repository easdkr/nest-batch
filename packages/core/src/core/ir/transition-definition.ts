import type { FlowExecutionStatus } from '../status';

export type FlowTransitionPattern = FlowExecutionStatus | string;

export interface TransitionDefinition {
  fromStepId: string;
  onStatus: FlowTransitionPattern;
  toStepId: string | null; // null = END
}
