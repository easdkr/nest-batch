import type { StepDefinition } from './step-definition';
import type { TransitionDefinition } from './transition-definition';
import type { ListenerDefinition } from './listener-definition';

export interface JobDefinition {
  id: string;
  steps: Record<string, StepDefinition>;
  startStepId: string;
  transitions: TransitionDefinition[];
  listeners: ListenerDefinition[];
  restartable: boolean;
  allowDuplicateInstances: boolean;
}
