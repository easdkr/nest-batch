export type ErrorClass = new (...args: any[]) => Error;
export type ErrorPredicate = (err: unknown) => boolean;
export type Skippable = ErrorClass | ErrorPredicate;

export interface SkipPolicyConfig {
  limit: number;
  skippable: Skippable[];
}

export type BackoffConfig =
  | { type: 'fixed'; ms: number }
  | { type: 'exponential'; initialMs: number; maxMs?: number; factor?: number }
  | { type: 'none' };

export interface RetryPolicyConfig {
  limit: number;
  retryable: Skippable[];
  backoff: BackoffConfig;
}
