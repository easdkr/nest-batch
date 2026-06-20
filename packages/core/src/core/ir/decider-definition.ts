import type { JobExecution } from '../repository/types';
import type { StepStatus } from '../status';

export interface JobExecutionDeciderContext {
  readonly jobExecution: JobExecution;
  readonly stepId: string;
  readonly stepExecutionId: string;
  readonly stepStatus: StepStatus;
  readonly exitCode: string;
  readonly exitMessage: string;
}

export type JobExecutionDecider = (
  context: JobExecutionDeciderContext,
) => string | Promise<string>;

export interface DeciderDefinition {
  readonly afterStepId: string;
  readonly decide: JobExecutionDecider;
}

export interface ReusableFlowDefinition {
  readonly transitions: readonly import('./transition-definition').TransitionDefinition[];
  readonly deciders?: readonly DeciderDefinition[];
}
