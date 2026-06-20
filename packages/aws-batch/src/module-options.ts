import type { ExternalTaskStrategyOptions } from '@nest-batch/core';

export const AWS_BATCH_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/aws-batch/AWS_BATCH_MODULE_OPTIONS',
);

export interface AwsBatchSubmitJobInput {
  readonly jobName: string;
  readonly jobQueue: string;
  readonly jobDefinition: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly containerOverrides?: {
    readonly command?: readonly string[];
    readonly environment?: readonly { readonly name: string; readonly value: string }[];
  };
  readonly arrayProperties?: { readonly size: number };
  readonly retryStrategy?: { readonly attempts?: number };
  readonly timeout?: { readonly attemptDurationSeconds?: number };
  readonly tags?: Readonly<Record<string, string>>;
}

export interface AwsBatchSubmitJobOutput {
  readonly jobId?: string;
  readonly jobName?: string;
}

export interface AwsBatchSubmitJobClient {
  submitJob(input: AwsBatchSubmitJobInput): Promise<AwsBatchSubmitJobOutput>;
}

export interface AwsBatchModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: AwsBatchSubmitJobClient;
  readonly jobQueue: string;
  readonly jobDefinition: string;
  readonly jobNamePrefix?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly arrayProperties?: { readonly size: number };
  readonly retryStrategy?: { readonly attempts?: number };
  readonly timeout?: { readonly attemptDurationSeconds?: number };
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ResolvedAwsBatchModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: AwsBatchSubmitJobClient;
  readonly jobQueue: string;
  readonly jobDefinition: string;
  readonly jobNamePrefix: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly arrayProperties?: { readonly size: number };
  readonly retryStrategy?: { readonly attempts?: number };
  readonly timeout?: { readonly attemptDurationSeconds?: number };
  readonly tags: Readonly<Record<string, string>>;
}

export function resolveAwsBatchOptions(
  options: AwsBatchModuleOptions,
): ResolvedAwsBatchModuleOptions {
  return Object.freeze({
    client: options.client,
    jobQueue: options.jobQueue,
    jobDefinition: options.jobDefinition,
    jobNamePrefix: options.jobNamePrefix ?? 'nest-batch',
    parameters: Object.freeze({ ...(options.parameters ?? {}) }),
    ...(options.arrayProperties !== undefined
      ? { arrayProperties: Object.freeze({ ...options.arrayProperties }) }
      : {}),
    ...(options.retryStrategy !== undefined
      ? { retryStrategy: Object.freeze({ ...options.retryStrategy }) }
      : {}),
    ...(options.timeout !== undefined ? { timeout: Object.freeze({ ...options.timeout }) } : {}),
    tags: Object.freeze({ ...(options.tags ?? {}) }),
    ...(options.workerCommand !== undefined
      ? { workerCommand: Object.freeze([...options.workerCommand]) }
      : {}),
    ...(options.env !== undefined ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.labels !== undefined ? { labels: Object.freeze({ ...options.labels }) } : {}),
  });
}
