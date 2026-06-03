import { Injectable } from '@nestjs/common';
import type { TransitionDefinition } from '../core/ir';
import type { FlowExecutionStatus } from '../core/status';
import { InvalidFlowGraphError } from '../core/errors';

/**
 * FlowEvaluator resolves the next step in a flow graph given the current step
 * and its exit status. It is a pure, side-effect-free decision function:
 * given the same inputs it always returns the same next step (or END).
 *
 * Per ORACLE verdict 3c, the API is uniformly async — even though the current
 * implementation is synchronous internally, returning a Promise keeps the
 * caller contract identical to future evaluators that may need to consult
 * remote state (e.g. conditional / data-driven transitions).
 */
@Injectable()
export class FlowEvaluator {
  /**
   * Evaluate the next step ID given the current step and exit status.
   *
   * - Returns `null` if the job should END — either no transition matches
   *   the (fromStepId, onStatus) pair, or the matching transition's
   *   `toStepId` is `null` (explicit END).
   * - Throws `InvalidFlowGraphError` with code `AMBIGUOUS_TRANSITION` if
   *   more than one transition matches the same (fromStepId, onStatus) —
   *   the graph is malformed and the caller must fix it (Metis: "Invalid
   *   flow graph fails validation: ambiguous transition").
   *
   * @param transitions  All transitions in the job's flow graph.
   * @param fromStepId   The current step's ID.
   * @param status       The current step's exit status.
   */
  async evaluate(
    transitions: TransitionDefinition[],
    fromStepId: string,
    status: FlowExecutionStatus,
  ): Promise<string | null> {
    const matches = transitions.filter(
      (t) => t.fromStepId === fromStepId && t.onStatus === status,
    );
    if (matches.length > 1) {
      throw new InvalidFlowGraphError(
        'AMBIGUOUS_TRANSITION',
        `Ambiguous transition from "${fromStepId}" on status "${status}": ${matches.length} matches`,
        { fromStepId, status, count: matches.length },
      );
    }
    if (matches.length === 0) return null;
    return matches[0]!.toStepId;
  }
}
