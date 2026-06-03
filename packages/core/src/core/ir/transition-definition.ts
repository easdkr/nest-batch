import type { FlowExecutionStatus } from '../status';

export interface TransitionDefinition {
  fromStepId: string;
  onStatus: FlowExecutionStatus;
  toStepId: string | null; // null = END
}
