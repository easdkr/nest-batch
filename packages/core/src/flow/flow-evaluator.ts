import { Injectable } from '@nestjs/common';
import type { TransitionDefinition } from '../core/ir';
import { InvalidFlowGraphError } from '../core/errors';

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+.:]/g, '\\$&');
}

function matchesPattern(pattern: string, status: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === status;
  }
  const source = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return escapeRegex(ch);
    })
    .join('');
  return new RegExp(`^${source}$`).test(status);
}

function patternSpecificity(pattern: string): number {
  let score = 0;
  for (const ch of pattern) {
    if (ch !== '*' && ch !== '?') score += 1;
  }
  return pattern.includes('*') || pattern.includes('?') ? score : score + 1000;
}

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
   * - Supports `*` and `?` wildcards in `onStatus`. Exact matches win
   *   over wildcard matches. If multiple matches have the same
   *   specificity, the graph is ambiguous and the caller must fix it.
   *
   * @param transitions  All transitions in the job's flow graph.
   * @param fromStepId   The current step's ID.
   * @param status       The current step's exit status.
   */
  async evaluate(
    transitions: TransitionDefinition[],
    fromStepId: string,
    status: string,
  ): Promise<string | null> {
    const matches = transitions.filter((t) => this.matches(t, fromStepId, status));
    if (matches.length === 0) return null;

    const ranked = matches.map((transition) => ({
      transition,
      specificity: patternSpecificity(transition.onStatus),
    }));
    const maxSpecificity = Math.max(...ranked.map((candidate) => candidate.specificity));
    const best = ranked.filter((candidate) => candidate.specificity === maxSpecificity);

    if (best.length > 1) {
      throw new InvalidFlowGraphError(
        'AMBIGUOUS_TRANSITION',
        `Ambiguous transition from "${fromStepId}" on status "${status}": ${best.length} matches`,
        { fromStepId, status, count: best.length },
      );
    }
    return best[0]!.transition.toStepId;
  }

  matches(transition: TransitionDefinition, fromStepId: string, status: string): boolean {
    return (
      transition.fromStepId === fromStepId &&
      matchesPattern(transition.onStatus, status)
    );
  }
}
