import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { JobLauncher, JobStatus, type JobParameters } from '@nest-batch/core';

interface ImportRequestBody {
  file: string;
  jobParams?: Record<string, unknown>;
}

@Controller('jobs')
export class BatchController {
  constructor(@Inject(JobLauncher) private readonly launcher: JobLauncher) {}

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
}
