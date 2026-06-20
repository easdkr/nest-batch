import { describe, expect, test } from 'vitest';

import {
  createAwsBatchRecipe,
  createEcsFargateRecipe,
  createKubernetesJobRecipe,
  createSqsEventBridgeRecipe,
} from '../src';

describe('deployment recipes', () => {
  test('creates ECS Fargate recipe with RunTask policy statements', () => {
    const recipe = createEcsFargateRecipe({
      clusterArn: 'arn:aws:ecs:cluster/batch',
      taskDefinitionArn: 'arn:aws:ecs:task-definition/batch:1',
      taskRoleArn: 'arn:aws:iam::123:role/task',
      executionRoleArn: 'arn:aws:iam::123:role/execution',
      subnets: ['subnet-a'],
    });

    expect(recipe.adapterPackage).toBe('@nest-batch/aws-ecs');
    expect(recipe.resources.iamPolicy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Action: ['ecs:RunTask'] }),
        expect.objectContaining({ Action: ['iam:PassRole'] }),
      ]),
    );
  });

  test('creates Kubernetes, AWS Batch, and SQS/EventBridge recipes', () => {
    expect(createKubernetesJobRecipe({ namespace: 'batch', image: 'app:latest' }).runtime).toBe(
      'kubernetes-job',
    );
    expect(
      createAwsBatchRecipe({
        jobQueueArn: 'arn:aws:batch:queue',
        jobDefinitionArn: 'arn:aws:batch:definition',
      }).runtime,
    ).toBe('aws-batch');
    expect(
      createSqsEventBridgeRecipe({
        queueArn: 'arn:aws:sqs:queue',
        schedulerRoleArn: 'arn:aws:iam::123:role/scheduler',
      }).runtime,
    ).toBe('sqs-eventbridge');
  });
});
