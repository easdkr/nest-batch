import type { SkipPolicyConfig, Skippable } from '../core/ir/policy-config';
import { InvalidFlowGraphError } from '../core/errors';

export interface SkipContext {
  item: unknown;
  phase: 'read' | 'process' | 'write';
  skipCount: number;
  skipLimit: number;
}

export interface SkipPolicy {
  shouldSkip(error: unknown, context: SkipContext): boolean;
}

function matchesSkippable(err: unknown, skippable: Skippable): boolean {
  if (typeof skippable === 'function') {
    if (
      skippable.prototype !== undefined &&
      skippable.prototype instanceof Error
    ) {
      return err instanceof (skippable as new (...args: unknown[]) => Error);
    }
    try {
      return (skippable as (err: unknown) => boolean)(err);
    } catch {
      return false;
    }
  }
  return false;
}

export function compileSkipPolicy(config: SkipPolicyConfig): SkipPolicy {
  if (config.limit <= 0) {
    throw new InvalidFlowGraphError(
      'INVALID_SKIP_LIMIT',
      `SkipPolicyConfig.limit must be > 0 (got ${config.limit})`,
      { limit: config.limit },
    );
  }
  return {
    shouldSkip(error: unknown, context: SkipContext): boolean {
      if (context.skipCount >= context.skipLimit) {
        // Limit reached; caller (ChunkProcessor) is expected to raise
        // SkipLimitExceededError. From the policy's perspective we simply
        // stop returning `true` for further candidate errors.
        return false;
      }
      return config.skippable.some((s) => matchesSkippable(error, s));
    },
  };
}
