import { Injectable } from '@nestjs/common';
import type { JobDefinition } from '../core/ir';
import { DefinitionValidator } from '../core/validation/definition-validator';
import {
  JobNotFoundError,
  DuplicateJobDefinitionError,
  InvalidFlowGraphError,
} from '../core/errors';

@Injectable()
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();
  private readonly validator = new DefinitionValidator();

  /**
   * Register a job definition. Validates the graph and throws on duplicates.
   */
  register(job: JobDefinition): void {
    if (this.definitions.has(job.id)) {
      throw new DuplicateJobDefinitionError(job.id);
    }
    this.validator.validate(job);
    this.definitions.set(job.id, job);
  }

  /**
   * Look up a job definition by ID. Throws JobNotFoundError if missing.
   */
  get(jobId: string): JobDefinition {
    const def = this.definitions.get(jobId);
    if (!def) throw new JobNotFoundError(jobId);
    return def;
  }

  has(jobId: string): boolean {
    return this.definitions.has(jobId);
  }

  getAll(): JobDefinition[] {
    return Array.from(this.definitions.values());
  }
}
