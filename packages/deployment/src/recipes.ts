export interface DeploymentRecipe {
  readonly name: string;
  readonly adapterPackage: string;
  readonly runtime: 'ecs-fargate' | 'kubernetes-job' | 'aws-batch' | 'sqs-eventbridge';
  readonly workerCommand: readonly string[];
  readonly requiredEnvironment: readonly string[];
  readonly resources: Readonly<Record<string, unknown>>;
}

export interface EcsFargateRecipeOptions {
  readonly clusterArn: string;
  readonly taskDefinitionArn: string;
  readonly taskRoleArn: string;
  readonly executionRoleArn: string;
  readonly subnets: readonly string[];
  readonly securityGroups?: readonly string[];
  readonly containerName?: string;
}

export function createEcsFargateRecipe(options: EcsFargateRecipeOptions): DeploymentRecipe {
  return {
    name: 'ecs-fargate-one-off-task',
    adapterPackage: '@nest-batch/aws-ecs',
    runtime: 'ecs-fargate',
    workerCommand: ['batch-worker'],
    requiredEnvironment: ['DATABASE_URL'],
    resources: {
      clusterArn: options.clusterArn,
      taskDefinitionArn: options.taskDefinitionArn,
      taskRoleArn: options.taskRoleArn,
      executionRoleArn: options.executionRoleArn,
      containerName: options.containerName ?? 'batch-worker',
      network: {
        subnets: [...options.subnets],
        securityGroups: [...(options.securityGroups ?? [])],
      },
      iamPolicy: createEcsRunTaskPolicyStatements({
        clusterArn: options.clusterArn,
        taskDefinitionArn: options.taskDefinitionArn,
        passRoleArns: [options.taskRoleArn, options.executionRoleArn],
      }),
    },
  };
}

export interface KubernetesJobRecipeOptions {
  readonly namespace: string;
  readonly image: string;
  readonly serviceAccountName?: string;
}

export function createKubernetesJobRecipe(
  options: KubernetesJobRecipeOptions,
): DeploymentRecipe {
  return {
    name: 'kubernetes-one-off-job',
    adapterPackage: '@nest-batch/kubernetes',
    runtime: 'kubernetes-job',
    workerCommand: ['batch-worker'],
    requiredEnvironment: ['DATABASE_URL'],
    resources: {
      namespace: options.namespace,
      image: options.image,
      ...(options.serviceAccountName !== undefined
        ? { serviceAccountName: options.serviceAccountName }
        : {}),
      rbac: {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['create', 'get', 'list', 'watch'],
      },
    },
  };
}

export interface AwsBatchRecipeOptions {
  readonly jobQueueArn: string;
  readonly jobDefinitionArn: string;
}

export function createAwsBatchRecipe(options: AwsBatchRecipeOptions): DeploymentRecipe {
  return {
    name: 'aws-batch-submit-job',
    adapterPackage: '@nest-batch/aws-batch',
    runtime: 'aws-batch',
    workerCommand: ['batch-worker'],
    requiredEnvironment: ['DATABASE_URL'],
    resources: {
      jobQueueArn: options.jobQueueArn,
      jobDefinitionArn: options.jobDefinitionArn,
      iamPolicy: [
        {
          Effect: 'Allow',
          Action: ['batch:SubmitJob', 'batch:DescribeJobs', 'batch:TerminateJob'],
          Resource: [options.jobQueueArn, options.jobDefinitionArn],
        },
      ],
    },
  };
}

export interface SqsEventBridgeRecipeOptions {
  readonly queueArn: string;
  readonly schedulerRoleArn: string;
  readonly scheduleGroupName?: string;
}

export function createSqsEventBridgeRecipe(
  options: SqsEventBridgeRecipeOptions,
): DeploymentRecipe {
  return {
    name: 'sqs-eventbridge-scheduler',
    adapterPackage: '@nest-batch/aws-sqs + @nest-batch/aws-eventbridge-scheduler',
    runtime: 'sqs-eventbridge',
    workerCommand: ['batch-worker'],
    requiredEnvironment: ['DATABASE_URL'],
    resources: {
      queueArn: options.queueArn,
      schedulerRoleArn: options.schedulerRoleArn,
      scheduleGroupName: options.scheduleGroupName ?? 'nest-batch',
      iamPolicy: [
        {
          Effect: 'Allow',
          Action: ['sqs:SendMessage'],
          Resource: [options.queueArn],
        },
      ],
    },
  };
}

export interface EcsRunTaskPolicyOptions {
  readonly clusterArn: string;
  readonly taskDefinitionArn: string;
  readonly passRoleArns: readonly string[];
}

export function createEcsRunTaskPolicyStatements(
  options: EcsRunTaskPolicyOptions,
): readonly Record<string, unknown>[] {
  return [
    {
      Effect: 'Allow',
      Action: ['ecs:RunTask'],
      Resource: [options.taskDefinitionArn],
      Condition: {
        ArnEquals: {
          'ecs:cluster': options.clusterArn,
        },
      },
    },
    {
      Effect: 'Allow',
      Action: ['iam:PassRole'],
      Resource: [...options.passRoleArns],
    },
  ];
}
