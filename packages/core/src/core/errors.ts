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

export class JobExecutionNotFoundError extends BatchError {
  readonly code = 'JOB_EXECUTION_NOT_FOUND';
  constructor(executionId: string) {
    super(`Job execution not found: ${executionId}`, { executionId });
  }
}

export class JobInstanceNotFoundError extends BatchError {
  readonly code = 'JOB_INSTANCE_NOT_FOUND';
  constructor(jobInstanceId: string) {
    super(`Job instance not found: ${jobInstanceId}`, { jobInstanceId });
  }
}

export class InvalidJobOperationError extends BatchError {
  readonly code = 'INVALID_JOB_OPERATION';
  constructor(operation: string, message: string, details?: unknown) {
    super(message, { operation, ...(typeof details === 'object' && details !== null ? details : {}) });
  }
}

export class UnsupportedJobRepositoryOperationError extends BatchError {
  readonly code = 'UNSUPPORTED_JOB_REPOSITORY_OPERATION';
  constructor(operation: string) {
    super(`JobRepository operation is not supported by this adapter: ${operation}`, {
      operation,
    });
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

/**
 * Thrown when a `RefKind.ProviderToken` ref cannot be resolved against
 * the executor's `providerResolvers` map (Task 9). The message always
 * carries the unresolved token id and the role (`reader` / `processor`
 * / `writer` / `tasklet` / `listener`) so log lines and test failures
 * identify the missing provider deterministically.
 *
 * Distinct from `ProviderNotFoundError` in the compiler, which fires
 * during IR compilation when a chunk step is missing a required item
 * handler method. This error fires at runtime when the DI binding for
 * an already-shaped ref cannot be located.
 */
export class ProviderTokenNotFoundError extends BatchError {
  readonly code = 'PROVIDER_TOKEN_NOT_FOUND';
  constructor(token: string, role: string) {
    super(`No provider bound for ${role} token: ${token}`, { token, role });
  }
}
