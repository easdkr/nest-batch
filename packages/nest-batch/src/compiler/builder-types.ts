import type {
  JobDefinition,
  StepDefinition,
  ListenerDefinition,
  TransitionDefinition,
} from '../core/ir';
import type { FlowExecutionStatus } from '../core/status';

/**
 * Configuration shape for the Builder API. The builder returns this from `build()`.
 * `DefinitionCompiler.compileFromBuilderConfig` consumes it and produces a
 * fully-validated `JobDefinition` IR.
 *
 * This is a *plain-data* shape — no methods, no Nest DI references — so a builder
 * can be assembled in unit tests without booting a Nest container.
 */
export interface JobBuilderConfig {
  id: string;
  restartable: boolean;
  allowDuplicateInstances: boolean;
  steps: StepDefinition[];
  startStepId: string;
  transitions: TransitionDefinition[];
  listeners: ListenerDefinition[];
}
