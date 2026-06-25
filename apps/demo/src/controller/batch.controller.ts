import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { JobLauncher, JobStatus, type JobParameters } from '@nest-batch/core';
import { MultiStepDemoJob } from '../jobs/multi-step-demo/multi-step-demo.job';

interface ImportRequestBody {
  file: string;
  jobParams?: Record<string, unknown>;
}

interface MultiStepDemoRequestBody {
  items?: number[];
  jobParams?: Record<string, unknown>;
}

@Controller('jobs')
export class BatchController {
  constructor(
    @Inject(JobLauncher) private readonly launcher: JobLauncher,
    @Inject(MultiStepDemoJob) private readonly multiStepDemoJob: MultiStepDemoJob,
  ) {}

  @Post('import-products')
  @HttpCode(HttpStatus.OK)
  async importProducts(
    @Body() body: ImportRequestBody,
  ): Promise<{ executionId: string; status: JobStatus }> {
    if (!body?.file) {
      throw new BadRequestException('Missing "file" in request body');
    }
    const params: JobParameters = {
      file: body.file,
      ...(body.jobParams ?? {}),
    };
    const execution = await this.launcher.launch('import-products', params);
    return { executionId: execution.id, status: execution.status };
  }

  @Post('multi-step-demo')
  @HttpCode(HttpStatus.OK)
  async multiStepDemo(
    @Body() body: MultiStepDemoRequestBody = {},
  ): Promise<{ executionId: string; status: JobStatus; events: string[] }> {
    const params: JobParameters = {
      ...(body.jobParams ?? {}),
      ...(body.items !== undefined ? { items: body.items } : {}),
    };
    const execution = await this.launcher.launch('multi-step-demo', params);
    return {
      executionId: execution.id,
      status: execution.status,
      events: this.multiStepDemoJob.getEvents(),
    };
  }
}
