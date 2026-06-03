import {
  JobDefinition,
  TransitionDefinition,
  StepDefinition,
} from '../ir';
import { InvalidFlowGraphError } from '../errors';

/**
 * Pure validation for a fully-built `JobDefinition` IR.
 *
 * Does not perform any execution, scheduling, or Nest wiring. After the
 * Builder/Compiler/Decorator API has assembled a `JobDefinition`, the
 * `DefinitionValidator` answers one question: "is this graph structurally
 * sound?" — by enforcing the invariants that the runtime executor relies on.
 *
 * Invariants enforced (in order):
 *
 *   1. EMPTY_JOB         — the job has at least one step.
 *   2. NO_START_STEP     — `startStepId` references an existing step.
 *   3. INVALID_CHUNK_SIZE — every `chunk` step has `chunkSize > 0`.
 *   4. MISSING_TARGET    — every transition's `from`/`to` references a
 *                          step that exists (or `toStepId === null` for END).
 *   5. UNREACHABLE_STEP  — every step is reachable from `startStepId`
 *                          via transitions (BFS).
 *   6. CYCLE_DETECTED    — the transition graph has no cycles (DFS with
 *                          recursion stack tracking).
 *
 * The order matters: cheap, local checks run first so a malformed job
 * fails fast before we walk the whole graph.
 *
 * Per ORACLE verdict 1b: "all transitions target existing steps, one start
 * step, no accidental cycles, terminal statuses are handled".
 */
export class DefinitionValidator {
  /**
   * Validates a complete `JobDefinition`. Throws `InvalidFlowGraphError`
   * on the first violation found, with a stable `code` (see class doc).
   */
  validate(job: JobDefinition): void {
    const stepIds = Object.keys(job.steps);

    // 1. At least one step.
    if (stepIds.length === 0) {
      throw new InvalidFlowGraphError(
        'EMPTY_JOB',
        `Job "${job.id}" has no steps`,
        { jobId: job.id },
      );
    }

    // 2. startStepId must reference an existing step.
    if (!(job.startStepId in job.steps)) {
      throw new InvalidFlowGraphError(
        'NO_START_STEP',
        `Job "${job.id}" startStepId "${job.startStepId}" is not in steps`,
        { jobId: job.id, startStepId: job.startStepId },
      );
    }

    // 3. Per-step invariants.
    for (const stepId of stepIds) {
      const step: StepDefinition = job.steps[stepId]!;
      if (step.kind === 'chunk' && step.chunkSize <= 0) {
        throw new InvalidFlowGraphError(
          'INVALID_CHUNK_SIZE',
          `Step "${stepId}" has invalid chunkSize ${step.chunkSize}`,
          { jobId: job.id, stepId, chunkSize: step.chunkSize },
        );
      }
    }

    // 4. Every transition's endpoints must exist.
    for (const t of job.transitions) {
      if (!(t.fromStepId in job.steps)) {
        throw new InvalidFlowGraphError(
          'MISSING_TARGET',
          `Transition fromStepId "${t.fromStepId}" not found in steps`,
          { jobId: job.id, fromStepId: t.fromStepId },
        );
      }
      if (t.toStepId !== null && !(t.toStepId in job.steps)) {
        throw new InvalidFlowGraphError(
          'MISSING_TARGET',
          `Transition toStepId "${t.toStepId}" not found in steps`,
          { jobId: job.id, toStepId: t.toStepId },
        );
      }
    }

    // 5. No unreachable steps (BFS from startStepId).
    const reachable = this.collectReachable(job);

    for (const stepId of stepIds) {
      if (!reachable.has(stepId)) {
        throw new InvalidFlowGraphError(
          'UNREACHABLE_STEP',
          `Step "${stepId}" is unreachable from startStepId "${job.startStepId}"`,
          { jobId: job.id, stepId, startStepId: job.startStepId },
        );
      }
    }

    // 6. No cycles (DFS with stack tracking).
    this.assertAcyclic(job);
  }

  /**
   * Lightweight, partial validation used by `FlowEvaluator` and the
   * `Builder` API when only a subset of steps/transitions is in scope.
   *
   * Mirrors rule 4 of `validate()` (transition endpoints must exist) but
   * does NOT enforce reachability, cycles, or the start step — those
   * require the full `JobDefinition` graph.
   */
  validateTransition(
    transitions: TransitionDefinition[],
    availableSteps: Record<string, StepDefinition>,
  ): void {
    for (const t of transitions) {
      if (!(t.fromStepId in availableSteps)) {
        throw new InvalidFlowGraphError(
          'MISSING_TARGET',
          `Transition fromStepId "${t.fromStepId}" not in steps`,
          { fromStepId: t.fromStepId },
        );
      }
      if (t.toStepId !== null && !(t.toStepId in availableSteps)) {
        throw new InvalidFlowGraphError(
          'MISSING_TARGET',
          `Transition toStepId "${t.toStepId}" not in steps`,
          { toStepId: t.toStepId },
        );
      }
    }
  }

  // --- private helpers --------------------------------------------------

  private collectReachable(job: JobDefinition): Set<string> {
    const reachable = new Set<string>();
    const queue: string[] = [job.startStepId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const t of job.transitions) {
        if (t.fromStepId === cur && t.toStepId !== null && !reachable.has(t.toStepId)) {
          queue.push(t.toStepId);
        }
      }
    }
    return reachable;
  }

  private assertAcyclic(job: JobDefinition): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const detectCycle = (stepId: string, path: readonly string[]): void => {
      if (inStack.has(stepId)) {
        throw new InvalidFlowGraphError(
          'CYCLE_DETECTED',
          `Cycle detected in job "${job.id}": ${[...path, stepId].join(' -> ')}`,
          { jobId: job.id, path: [...path, stepId] },
        );
      }
      if (visited.has(stepId)) return;
      visited.add(stepId);
      inStack.add(stepId);
      for (const t of job.transitions) {
        if (t.fromStepId === stepId && t.toStepId !== null) {
          detectCycle(t.toStepId, [...path, stepId]);
        }
      }
      inStack.delete(stepId);
    };
    detectCycle(job.startStepId, []);
  }
}
