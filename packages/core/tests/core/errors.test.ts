import { describe, it, expect } from 'vitest';
import {
  BatchError,
  JobNotFoundError,
  DuplicateJobDefinitionError,
  InvalidFlowGraphError,
  SkipLimitExceededError,
  RetryLimitExceededError,
  JobExecutionAlreadyRunningError,
  InvalidExecutionContextError,
} from '../../src/core/errors';

describe('BatchError (abstract base)', () => {
  it('cannot be instantiated directly (compile-time guard)', () => {
    // @ts-expect-error - abstract class cannot be instantiated
    new BatchError('x');
    expect(true).toBe(true);
  });
});

describe('JobNotFoundError', () => {
  it('has code JOB_NOT_FOUND and message includes the jobId', () => {
    const err = new JobNotFoundError('foo');
    expect(err.code).toBe('JOB_NOT_FOUND');
    expect(err.message).toContain('foo');
  });
  it('exposes jobId in details', () => {
    const err = new JobNotFoundError('foo');
    expect(err.details).toEqual({ jobId: 'foo' });
  });
  it('extends BatchError', () => {
    const err = new JobNotFoundError('foo');
    expect(err).toBeInstanceOf(BatchError);
    expect(err).toBeInstanceOf(JobNotFoundError);
  });
  it('name === constructor name', () => {
    const err = new JobNotFoundError('foo');
    expect(err.name).toBe('JobNotFoundError');
  });
});

describe('DuplicateJobDefinitionError', () => {
  it('has code DUPLICATE_JOB and message includes the jobId', () => {
    const err = new DuplicateJobDefinitionError('bar');
    expect(err.code).toBe('DUPLICATE_JOB');
    expect(err.message).toContain('bar');
  });
  it('extends BatchError', () => {
    const err = new DuplicateJobDefinitionError('bar');
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new DuplicateJobDefinitionError('bar');
    expect(err.name).toBe('DuplicateJobDefinitionError');
  });
});

describe('InvalidFlowGraphError', () => {
  it('takes a code, message, and optional details', () => {
    const err = new InvalidFlowGraphError('CYCLE_DETECTED', 'cycle found');
    expect(err.code).toBe('CYCLE_DETECTED');
    expect(err.message).toBe('cycle found');
  });
  it('forwards details when provided', () => {
    const err = new InvalidFlowGraphError('NO_START_STEP', 'no start', {
      steps: ['a', 'b'],
    });
    expect(err.code).toBe('NO_START_STEP');
    expect(err.details).toEqual({ steps: ['a', 'b'] });
  });
  it('details is undefined when omitted', () => {
    const err = new InvalidFlowGraphError('UNREACHABLE_STEP', 'unreachable');
    expect(err.details).toBeUndefined();
  });
  it('extends BatchError', () => {
    const err = new InvalidFlowGraphError('AMBIGUOUS_TRANSITION', 'amb');
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new InvalidFlowGraphError('X', 'y');
    expect(err.name).toBe('InvalidFlowGraphError');
  });
});

describe('SkipLimitExceededError', () => {
  it('has code SKIP_LIMIT_EXCEEDED and details.limit === 5', () => {
    const err = new SkipLimitExceededError(5);
    expect(err.code).toBe('SKIP_LIMIT_EXCEEDED');
    expect(err.details).toEqual({ limit: 5 });
  });
  it('uses default message when none provided', () => {
    const err = new SkipLimitExceededError(5);
    expect(err.message).toContain('5');
  });
  it('accepts a custom message', () => {
    const err = new SkipLimitExceededError(10, 'too many skips');
    expect(err.message).toBe('too many skips');
  });
  it('extends BatchError', () => {
    const err = new SkipLimitExceededError(1);
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new SkipLimitExceededError(1);
    expect(err.name).toBe('SkipLimitExceededError');
  });
});

describe('RetryLimitExceededError', () => {
  it('has code RETRY_LIMIT_EXCEEDED and details.limit === 3', () => {
    const err = new RetryLimitExceededError(3);
    expect(err.code).toBe('RETRY_LIMIT_EXCEEDED');
    expect(err.details).toEqual({ limit: 3 });
  });
  it('uses default message when none provided', () => {
    const err = new RetryLimitExceededError(3);
    expect(err.message).toContain('3');
  });
  it('accepts a custom message', () => {
    const err = new RetryLimitExceededError(7, 'gave up');
    expect(err.message).toBe('gave up');
  });
  it('extends BatchError', () => {
    const err = new RetryLimitExceededError(1);
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new RetryLimitExceededError(1);
    expect(err.name).toBe('RetryLimitExceededError');
  });
});

describe('JobExecutionAlreadyRunningError', () => {
  it('has code JOB_EXECUTION_ALREADY_RUNNING', () => {
    const err = new JobExecutionAlreadyRunningError('inst-1');
    expect(err.code).toBe('JOB_EXECUTION_ALREADY_RUNNING');
  });
  it('exposes jobInstanceId in details', () => {
    const err = new JobExecutionAlreadyRunningError('inst-1');
    expect(err.details).toEqual({ jobInstanceId: 'inst-1' });
  });
  it('message includes the instance id', () => {
    const err = new JobExecutionAlreadyRunningError('inst-1');
    expect(err.message).toContain('inst-1');
  });
  it('extends BatchError', () => {
    const err = new JobExecutionAlreadyRunningError('inst-1');
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new JobExecutionAlreadyRunningError('inst-1');
    expect(err.name).toBe('JobExecutionAlreadyRunningError');
  });
});

describe('InvalidExecutionContextError', () => {
  it('has code INVALID_EXECUTION_CONTEXT', () => {
    const err = new InvalidExecutionContextError('bad ctx');
    expect(err.code).toBe('INVALID_EXECUTION_CONTEXT');
  });
  it('forwards message and details', () => {
    const err = new InvalidExecutionContextError('bad ctx', { reason: 'X' });
    expect(err.message).toBe('bad ctx');
    expect(err.details).toEqual({ reason: 'X' });
  });
  it('extends BatchError', () => {
    const err = new InvalidExecutionContextError('bad ctx');
    expect(err).toBeInstanceOf(BatchError);
  });
  it('name === constructor name', () => {
    const err = new InvalidExecutionContextError('bad ctx');
    expect(err.name).toBe('InvalidExecutionContextError');
  });
});
