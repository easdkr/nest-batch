import type { BackoffConfig } from '../core/ir/policy-config';

export function compileBackoff(config: BackoffConfig): (attempt: number) => number {
  switch (config.type) {
    case 'none':
      return () => 0;
    case 'fixed':
      return () => config.ms;
    case 'exponential': {
      const factor = config.factor ?? 2;
      const maxMs = config.maxMs;
      return (attempt: number) => {
        const ms = config.initialMs * Math.pow(factor, Math.max(0, attempt - 1));
        return maxMs !== undefined ? Math.min(ms, maxMs) : ms;
      };
    }
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown backoff type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
