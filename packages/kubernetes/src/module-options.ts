import type { ExternalTaskStrategyOptions } from '@nest-batch/core';

export const KUBERNETES_JOB_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/kubernetes/KUBERNETES_JOB_MODULE_OPTIONS',
);

export interface KubernetesEnvVar {
  readonly name: string;
  readonly value: string;
}

export interface KubernetesJobManifest {
  readonly apiVersion: 'batch/v1';
  readonly kind: 'Job';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: {
    readonly backoffLimit?: number;
    readonly ttlSecondsAfterFinished?: number;
    readonly template: {
      readonly metadata: {
        readonly labels: Readonly<Record<string, string>>;
      };
      readonly spec: {
        readonly restartPolicy: 'Never' | 'OnFailure';
        readonly serviceAccountName?: string;
        readonly containers: readonly [
          {
            readonly name: string;
            readonly image: string;
            readonly imagePullPolicy?: string;
            readonly command?: readonly string[];
            readonly args: readonly string[];
            readonly env: readonly KubernetesEnvVar[];
          },
        ];
      };
    };
  };
}

export interface KubernetesCreateJobInput {
  readonly namespace: string;
  readonly body: KubernetesJobManifest;
}

export interface KubernetesCreateJobOutput {
  readonly name?: string;
  readonly uid?: string;
}

export interface KubernetesJobClient {
  createJob(input: KubernetesCreateJobInput): Promise<KubernetesCreateJobOutput>;
}

export interface KubernetesJobModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: KubernetesJobClient;
  readonly namespace: string;
  readonly image: string;
  readonly jobNamePrefix?: string;
  readonly containerName?: string;
  readonly command?: readonly string[];
  readonly imagePullPolicy?: string;
  readonly restartPolicy?: 'Never' | 'OnFailure';
  readonly backoffLimit?: number;
  readonly ttlSecondsAfterFinished?: number;
  readonly serviceAccountName?: string;
}

export interface ResolvedKubernetesJobModuleOptions extends ExternalTaskStrategyOptions {
  readonly client: KubernetesJobClient;
  readonly namespace: string;
  readonly image: string;
  readonly jobNamePrefix: string;
  readonly containerName: string;
  readonly command?: readonly string[];
  readonly imagePullPolicy?: string;
  readonly restartPolicy: 'Never' | 'OnFailure';
  readonly backoffLimit?: number;
  readonly ttlSecondsAfterFinished?: number;
  readonly serviceAccountName?: string;
}

export function resolveKubernetesJobOptions(
  options: KubernetesJobModuleOptions,
): ResolvedKubernetesJobModuleOptions {
  return Object.freeze({
    client: options.client,
    namespace: options.namespace,
    image: options.image,
    jobNamePrefix: options.jobNamePrefix ?? 'nest-batch',
    containerName: options.containerName ?? 'batch-worker',
    ...(options.command !== undefined ? { command: Object.freeze([...options.command]) } : {}),
    ...(options.imagePullPolicy !== undefined
      ? { imagePullPolicy: options.imagePullPolicy }
      : {}),
    restartPolicy: options.restartPolicy ?? 'Never',
    ...(options.backoffLimit !== undefined ? { backoffLimit: options.backoffLimit } : {}),
    ...(options.ttlSecondsAfterFinished !== undefined
      ? { ttlSecondsAfterFinished: options.ttlSecondsAfterFinished }
      : {}),
    ...(options.serviceAccountName !== undefined
      ? { serviceAccountName: options.serviceAccountName }
      : {}),
    ...(options.workerCommand !== undefined
      ? { workerCommand: Object.freeze([...options.workerCommand]) }
      : {}),
    ...(options.env !== undefined ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.labels !== undefined ? { labels: Object.freeze({ ...options.labels }) } : {}),
  });
}
