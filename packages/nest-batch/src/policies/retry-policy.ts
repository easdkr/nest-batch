import type { RetryPolicyConfig, Skippable, BackoffConfig } from '../core/ir/policy-config';

export interface RetryContext {
  item: unknown | null;
  phase: 'read' | 'process' | 'write';
  attempt: number; // 1-based
  retryLimit: number;
}

export interface RetryPolicy {
  canRetry(error: unknown, context: RetryContext): boolean;
  backoffMs(attempt: number): number;
}

function matchesSkippable(err: unknown, skippable: Skippable): boolean {
  if (typeof skippable === 'function') {
    if (skippable.length === 1) {
      try {
        return (skippable as (err: unknown) => boolean)(err);
      } catch {
        return false;
      }
    }
    return err instanceof (skippable as new (...args: unknown[]) => Error);
  }
  return false;
}

export function compileRetryPolicy(config: RetryPolicyConfig): RetryPolicy {
  if (config.limit <= 0) {
    throw new Error(`RetryPolicyConfig.limit must be > 0 (got ${config.limit})`);
  }
  const backoff = (cfg: BackoffConfig, attempt: number): number => {
    switch (cfg.type) {
      case 'none':
        return 0;
      case 'fixed':
        return cfg.ms;
      case 'exponential': {
        const factor = cfg.factor ?? 2;
        const ms = cfg.initialMs * Math.pow(factor, Math.max(0, attempt - 1));
        return cfg.maxMs !== undefined ? Math.min(ms, cfg.maxMs) : ms;
      }
      default:
        return 0;
    }
  };
  return {
    canRetry(error: unknown, context: RetryContext): boolean {
      if (context.attempt > context.retryLimit) return false;
      return config.retryable.some((s) => matchesSkippable(error, s));
    },
    backoffMs(attempt: number): number {
      return backoff(config.backoff, attempt);
    },
  };
}
