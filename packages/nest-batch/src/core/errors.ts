export abstract class BatchError extends Error {
  abstract readonly code: string;
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class JobNotFoundError extends BatchError {
  readonly code = 'JOB_NOT_FOUND';
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`, { jobId });
  }
}

export class DuplicateJobDefinitionError extends BatchError {
  readonly code = 'DUPLICATE_JOB';
  constructor(jobId: string) {
    super(`Job already registered: ${jobId}`, { jobId });
  }
}

export class InvalidFlowGraphError extends BatchError {
  readonly code: string;
  constructor(code: string, message: string, details?: unknown) {
    super(message, details);
    this.code = code;
  }
}

export class SkipLimitExceededError extends BatchError {
  readonly code = 'SKIP_LIMIT_EXCEEDED';
  constructor(limit: number, message?: string) {
    super(message ?? `Skip limit exceeded: ${limit}`, { limit });
  }
}

export class RetryLimitExceededError extends BatchError {
  readonly code = 'RETRY_LIMIT_EXCEEDED';
  constructor(limit: number, message?: string) {
    super(message ?? `Retry limit exceeded: ${limit}`, { limit });
  }
}

export class JobExecutionAlreadyRunningError extends BatchError {
  readonly code = 'JOB_EXECUTION_ALREADY_RUNNING';
  constructor(jobInstanceId: string) {
    super(`Job instance already running: ${jobInstanceId}`, { jobInstanceId });
  }
}

/**
 * Thrown when a restart is attempted against a JobDefinition that was
 * declared with `restartable: false`. Restarting a FAILED execution is
 * opt-in — by default the in-memory repository and most adapters are
 * non-restartable because their contexts are process-local and lost on
 * crash. (Per Metis: in-memory is `restartable: false` by default.)
 */
export class JobNotRestartableError extends BatchError {
  readonly code = 'JOB_NOT_RESTARTABLE';
  constructor(jobId: string) {
    super(`Job is not restartable: ${jobId}`, { jobId });
  }
}

export class InvalidExecutionContextError extends BatchError {
  readonly code = 'INVALID_EXECUTION_CONTEXT';
  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}
