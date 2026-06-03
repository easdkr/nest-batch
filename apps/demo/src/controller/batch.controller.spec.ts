import 'reflect-metadata';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BatchController } from './batch.controller';
import { JobLauncher, JobStatus, JobNotFoundError, type JobExecution, type JobParameters } from '@nest-batch/core';

function makeJobExecution(id: string, status: JobStatus = JobStatus.COMPLETED): JobExecution {
  return {
    id,
    jobInstanceId: `inst-${id}`,
    status,
    startTime: new Date(),
    endTime: new Date(),
    exitCode: 'COMPLETED',
    exitMessage: '',
    params: {},
  };
}

describe('BatchController — POST /jobs/import-products', () => {
  let app: INestApplication;
  let mockLaunch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockLaunch = vi.fn(async (jobId: string, _params: JobParameters) => {
      if (jobId !== 'import-products') {
        throw new JobNotFoundError(jobId);
      }
      return makeJobExecution('exec-test-123');
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BatchController],
      providers: [
        {
          provide: JobLauncher,
          useValue: { launch: mockLaunch },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  test('POST with a valid file returns 200 and an executionId', async () => {
    const response = await request(app.getHttpServer())
      .post('/jobs/import-products')
      .send({ file: 'sample-data/products-valid.csv' })
      .expect(200);

    expect(response.body).toMatchObject({
      executionId: 'exec-test-123',
      status: JobStatus.COMPLETED,
    });
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockLaunch).toHaveBeenCalledWith('import-products', {
      file: 'sample-data/products-valid.csv',
    });
  });

  test('POST with a missing file field returns 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/jobs/import-products')
      .send({})
      .expect(400);

    expect(response.body.message).toMatch(/file/);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  test('POST with an empty body returns 400', async () => {
    await request(app.getHttpServer())
      .post('/jobs/import-products')
      .send()
      .expect(400);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  test('POST whose launcher throws JobNotFoundError propagates as a 500', async () => {
    mockLaunch.mockImplementationOnce(async (jobId: string) => {
      throw new JobNotFoundError(jobId);
    });

    await request(app.getHttpServer())
      .post('/jobs/import-products')
      .send({ file: 'sample-data/products-valid.csv' })
      .expect(500);
  });

  test('POST passes optional jobParams through to the launcher', async () => {
    await request(app.getHttpServer())
      .post('/jobs/import-products')
      .send({ file: 'sample-data/x.csv', jobParams: { foo: 'bar' } })
      .expect(200);

    expect(mockLaunch).toHaveBeenCalledWith('import-products', {
      file: 'sample-data/x.csv',
      foo: 'bar',
    });
  });

  afterEach(async () => {
    await app?.close();
  });
});
