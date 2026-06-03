import type {
  StepDefinition,
  TransitionDefinition,
  ListenerDefinition,
} from '../core/ir';
import type { FlowExecutionStatus } from '../core/status';
import type { JobBuilderConfig } from '../compiler/builder-types';
import { StepBuilder } from './step-builder';

/**
 * Fluent builder for a single batch job.
 *
 * Responsibilities:
 *   - Configure job-level flags (id, restartable, allowDuplicateInstances).
 *   - Accumulate step definitions (as literals or via `StepBuilder` callback).
 *   - Build a transition graph with a small state machine driven by
 *     `.from(stepId).on(status).to(stepId)` / `.end()`.
 *   - Collect job-level `ListenerDefinition`s.
 *   - Emit a plain-data `JobBuilderConfig` from `.build()`.
 *
 * No execution, no DI, no Nest container — the produced config is
 * consumed downstream by `DefinitionCompiler.compileFromBuilderConfig`.
 */
export class JobBuilder {
  // Field names use a `_` prefix to avoid colliding with the same-named
  // setter methods (`restartable` / `allowDuplicateInstances`). With
  // `useDefineForClassFields: false` (project tsconfig), a class field
  // shadows any prototype method of the same name — which would make the
  // fluent setters unreachable on instances.
  private _restartable = false;
  private _allowDuplicateInstances = false;
  private readonly steps: Record<string, StepDefinition> = {};
  private readonly stepOrder: string[] = [];
  private readonly transitions: TransitionDefinition[] = [];
  private readonly listeners: ListenerDefinition[] = [];
  private currentTransition: {
    fromStepId?: string;
    onStatus?: FlowExecutionStatus;
    toStepId?: string | null;
  } | null = null;

  private constructor(private readonly id: string) {}

  static create(id: string): JobBuilder {
    return new JobBuilder(id);
  }

  // --- job-level flags -------------------------------------------------

  restartable(value: boolean): this {
    this._restartable = value;
    return this;
  }

  allowDuplicateInstances(value: boolean): this {
    this._allowDuplicateInstances = value;
    return this;
  }

  // --- steps -----------------------------------------------------------

  /**
   * Add a step. Accepts either a `StepDefinition` literal or a callback
   * that receives a `StepBuilder` and returns a configured builder.
   *
   *   .addStep({ kind: 'tasklet', id: 's1', tasklet, listeners: [] })
   *   .addStep((b) => b.tasklet('s2', taskletRef))
   *   .addStep((b) => b.chunk('c1', 50, { reader, writer }))
   */
  addStep(step: StepDefinition | ((b: StepBuilder) => StepBuilder)): this {
    let stepDef: StepDefinition;
    if (typeof step === 'function') {
      const sb = new StepBuilder();
      const result = step(sb);
      stepDef = result.build();
    } else {
      stepDef = step;
    }
    this.steps[stepDef.id] = stepDef;
    this.stepOrder.push(stepDef.id);
    return this;
  }

  // --- transitions -----------------------------------------------------

  /**
   * Set the source step of the current transition.
   *
   * If a previous transition was fully specified (from + on + to), it is
   * committed first — so callers can chain `.from('a').on(X).to('b')`
   * and immediately start a new `.from('c')…` chain on the same builder.
   */
  from(stepId: string): this {
    if (
      this.currentTransition &&
      this.currentTransition.onStatus !== undefined &&
      this.currentTransition.toStepId !== undefined
    ) {
      this.commitTransition();
    }
    this.currentTransition = { fromStepId: stepId };
    return this;
  }

  /**
   * Set the status that triggers the current transition.
   * Must be called after `.from(stepId)`.
   */
  on(status: FlowExecutionStatus): this {
    if (!this.currentTransition?.fromStepId) {
      throw new Error('Transition must start with .from(stepId)');
    }
    this.currentTransition.onStatus = status;
    return this;
  }

  /**
   * Set the target step of the current transition and commit it.
   */
  to(stepId: string): this {
    if (!this.currentTransition) {
      throw new Error('Use .from(stepId) before .to(stepId)');
    }
    this.currentTransition.toStepId = stepId;
    this.commitTransition();
    return this;
  }

  /**
   * End the current transition with `toStepId: null` (END of flow) and commit it.
   */
  end(): this {
    if (!this.currentTransition) {
      throw new Error('Use .from(stepId) before .end()');
    }
    this.currentTransition.toStepId = null;
    this.commitTransition();
    return this;
  }

  // --- listeners -------------------------------------------------------

  /** Add a job-level listener definition. */
  addListener(listener: ListenerDefinition): this {
    this.listeners.push(listener);
    return this;
  }

  // --- build -----------------------------------------------------------

  /**
   * Produce the `JobBuilderConfig` that `DefinitionCompiler.compileFromBuilderConfig`
   * consumes. Commits any pending in-progress transition.
   *
   * Throws if the job has no steps (the validator would also catch this
   * downstream, but failing here gives a clearer error at build site).
   */
  build(): JobBuilderConfig {
    if (this.currentTransition) this.commitTransition();
    if (this.stepOrder.length === 0) {
      throw new Error(`JobBuilder: job "${this.id}" has no steps`);
    }
    return {
      id: this.id,
      restartable: this._restartable,
      allowDuplicateInstances: this._allowDuplicateInstances,
      steps: this.stepOrder.map((id) => this.steps[id]!),
      startStepId: this.stepOrder[0]!,
      transitions: this.transitions,
      listeners: this.listeners,
    };
  }

  // --- internal --------------------------------------------------------

  private commitTransition(): void {
    if (!this.currentTransition) return;
    const t = this.currentTransition;
    if (t.fromStepId && t.onStatus !== undefined && t.toStepId !== undefined) {
      this.transitions.push({
        fromStepId: t.fromStepId,
        onStatus: t.onStatus,
        toStepId: t.toStepId,
      });
    }
    this.currentTransition = null;
  }
}
