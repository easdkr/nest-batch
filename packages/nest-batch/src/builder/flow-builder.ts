import type { TransitionDefinition } from '../core/ir';
import type { FlowExecutionStatus } from '../core/status';

/**
 * Focused fluent builder for a single `TransitionDefinition`.
 *
 * Mirrors the flow methods exposed on `JobBuilder` (`from` / `on` / `to` /
 * `end`) but is a standalone, single-use object: `.build()` produces a
 * fully-validated `TransitionDefinition` value, and the instance is then
 * discarded.
 *
 * Two intended usages:
 *
 *   1. **Standalone** — when callers want to build a transition literal
 *      outside of a `JobBuilder` (e.g. inside helper functions or test
 *      fixtures that don't need the full job context):
 *
 *        const t = new FlowBuilder()
 *          .from('s1')
 *          .on(FlowExecutionStatus.FAILED)
 *          .to('recovery')
 *          .build();
 *
 *   2. **Reuse** — the same chain shape as `JobBuilder`'s flow methods.
 *      This class is the canonical type the chain returns at the
 *      `.from(stepId)` step; `JobBuilder.from` simply exposes the same
 *      shape via its own convenience methods.
 *
 * The class is intentionally minimal: no Nest DI, no execution, no
 * validation beyond "is the transition fully specified?" — the
 * `DefinitionValidator` does the graph-level checks
 * (reachability, cycles, missing targets) downstream.
 */
export class FlowBuilder {
  private fromStepId?: string;
  private onStatus?: FlowExecutionStatus;
  private toStepId: string | null | undefined;
  private committed = false;

  /**
   * Convenience constructor that immediately calls `.from(stepId)`.
   *
   *   FlowBuilder.from('s1').on(FAILED).to('s2').build()
   */
  static from(stepId: string): FlowBuilder {
    return new FlowBuilder().from(stepId);
  }

  /** Set the source step of the transition. */
  from(stepId: string): this {
    if (this.committed) {
      throw new Error('FlowBuilder already committed; create a new instance');
    }
    this.fromStepId = stepId;
    return this;
  }

  /** Set the status that triggers the transition. Must follow `.from()`. */
  on(status: FlowExecutionStatus): this {
    if (this.committed) {
      throw new Error('FlowBuilder already committed; create a new instance');
    }
    if (this.fromStepId === undefined) {
      throw new Error('FlowBuilder: call .from(stepId) before .on(status)');
    }
    this.onStatus = status;
    return this;
  }

  /** Set the target step and commit. `null` is reserved for `.end()`. */
  to(stepId: string): this {
    if (this.committed) {
      throw new Error('FlowBuilder already committed; create a new instance');
    }
    if (this.fromStepId === undefined || this.onStatus === undefined) {
      throw new Error('FlowBuilder: call .from() and .on() before .to()');
    }
    this.toStepId = stepId;
    this.committed = true;
    return this;
  }

  /** End the transition (target = null) and commit. */
  end(): this {
    if (this.committed) {
      throw new Error('FlowBuilder already committed; create a new instance');
    }
    if (this.fromStepId === undefined || this.onStatus === undefined) {
      throw new Error('FlowBuilder: call .from() and .on() before .end()');
    }
    this.toStepId = null;
    this.committed = true;
    return this;
  }

  /**
   * Produce the final `TransitionDefinition`. Throws if the chain is
   * incomplete (missing from/on, or never committed via `.to()`/`.end()`).
   */
  build(): TransitionDefinition {
    if (!this.committed) {
      throw new Error('FlowBuilder: must be committed via .to() or .end()');
    }
    if (this.fromStepId === undefined) {
      throw new Error('FlowBuilder: missing .from(stepId)');
    }
    if (this.onStatus === undefined) {
      throw new Error('FlowBuilder: missing .on(status)');
    }
    if (this.toStepId === undefined) {
      throw new Error('FlowBuilder: missing .to(stepId) or .end()');
    }
    return {
      fromStepId: this.fromStepId,
      onStatus: this.onStatus,
      toStepId: this.toStepId,
    };
  }
}
