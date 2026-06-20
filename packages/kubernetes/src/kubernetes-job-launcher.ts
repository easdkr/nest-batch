import { Inject, Injectable } from '@nestjs/common';
import type {
  ExternalTaskLauncher,
  ExternalTaskLaunchRequest,
  ExternalTaskLaunchResult,
} from '@nest-batch/core';

import {
  KUBERNETES_JOB_MODULE_OPTIONS,
  type KubernetesJobManifest,
  type ResolvedKubernetesJobModuleOptions,
} from './module-options';

export const KUBERNETES_JOB_STRATEGY_NAME = 'kubernetes-job';

@Injectable()
export class KubernetesJobLauncher implements ExternalTaskLauncher {
  readonly name = KUBERNETES_JOB_STRATEGY_NAME;

  constructor(
    @Inject(KUBERNETES_JOB_MODULE_OPTIONS)
    private readonly options: ResolvedKubernetesJobModuleOptions,
  ) {}

  async launch(request: ExternalTaskLaunchRequest): Promise<ExternalTaskLaunchResult> {
    const body = this.buildJobManifest(request);
    const output = await this.options.client.createJob({
      namespace: this.options.namespace,
      body,
    });
    return {
      provider: this.name,
      externalId: output.uid ?? output.name ?? body.metadata.name,
      metadata: {
        namespace: this.options.namespace,
        name: output.name ?? body.metadata.name,
      },
    };
  }

  buildJobManifest(request: ExternalTaskLaunchRequest): KubernetesJobManifest {
    const labels = this.buildLabels(request);
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: this.buildJobName(request.jobExecutionId),
        namespace: this.options.namespace,
        labels,
      },
      spec: {
        ...(this.options.backoffLimit !== undefined
          ? { backoffLimit: this.options.backoffLimit }
          : {}),
        ...(this.options.ttlSecondsAfterFinished !== undefined
          ? { ttlSecondsAfterFinished: this.options.ttlSecondsAfterFinished }
          : {}),
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: this.options.restartPolicy,
            ...(this.options.serviceAccountName !== undefined
              ? { serviceAccountName: this.options.serviceAccountName }
              : {}),
            containers: [
              {
                name: this.options.containerName,
                image: this.options.image,
                ...(this.options.imagePullPolicy !== undefined
                  ? { imagePullPolicy: this.options.imagePullPolicy }
                  : {}),
                ...(this.options.command !== undefined ? { command: this.options.command } : {}),
                args: [...request.workerArgs],
                env: Object.entries(request.env).map(([name, value]) => ({
                  name,
                  value,
                })),
              },
            ],
          },
        },
      },
    };
  }

  private buildJobName(jobExecutionId: string): string {
    const suffix = jobExecutionId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const name = `${this.options.jobNamePrefix}-${suffix}`.replace(/^-+|-+$/g, '');
    return name.slice(0, 63).replace(/-+$/g, '');
  }

  private buildLabels(
    request: ExternalTaskLaunchRequest,
  ): Readonly<Record<string, string>> {
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.labels)) {
      labels[key] = toLabelValue(value);
    }
    labels['app.kubernetes.io/name'] = 'nest-batch';
    labels['nest-batch/job-id'] = toLabelValue(request.jobId);
    labels['nest-batch/job-execution-id'] = toLabelValue(request.jobExecutionId);
    return labels;
  }
}

function toLabelValue(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || 'unknown';
}
