import { randomUUID } from 'crypto';

/**
 * Generates unique IDs for JobInstances, JobExecutions, StepExecutions.
 * The default implementation uses crypto.randomUUID() (v4).
 * Tests can use DeterministicIdGenerator for predictable output.
 */
export interface IdGenerator {
  next(): string;
}

export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class DeterministicIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix: string = 'id') {}
  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}
