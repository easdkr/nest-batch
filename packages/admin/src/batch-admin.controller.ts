import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  JobExplorer,
  JobOperator,
  type JobExecutionFilter,
  type JobParameters,
  type JobStatus,
} from '@nest-batch/core';

import { renderBatchAdminHtml } from './batch-admin.renderer';

@Controller('batch')
export class BatchAdminController {
  constructor(
    private readonly explorer: JobExplorer,
    private readonly operator: JobOperator,
  ) {}

  @Get()
  async dashboard(): Promise<string> {
    const [jobs, executions] = await Promise.all([
      Promise.resolve(this.explorer.listJobs()),
      this.explorer.listJobExecutions({}),
    ]);
    return renderBatchAdminHtml({ jobs, executions });
  }

  @Get('jobs')
  listJobs(): ReturnType<JobExplorer['listJobs']> {
    return this.explorer.listJobs();
  }

  @Get('jobs/:jobName/instances')
  listJobInstances(@Param('jobName') jobName: string): ReturnType<JobExplorer['listJobInstances']> {
    return this.explorer.listJobInstances({ jobName });
  }

  @Get('executions')
  listJobExecutions(
    @Query('jobInstanceId') jobInstanceId?: string,
    @Query('status') status?: JobStatus,
  ): ReturnType<JobExplorer['listJobExecutions']> {
    const filter: JobExecutionFilter = {
      ...(jobInstanceId !== undefined ? { jobInstanceId } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    return this.explorer.listJobExecutions(filter);
  }

  @Get('executions/:executionId')
  getExecution(@Param('executionId') executionId: string): ReturnType<JobExplorer['getJobExecutionDetails']> {
    return this.explorer.getJobExecutionDetails(executionId);
  }

  @Post('executions/:executionId/stop')
  stop(@Param('executionId') executionId: string): ReturnType<JobOperator['stop']> {
    return this.operator.stop(executionId);
  }

  @Post('executions/:executionId/restart')
  restart(@Param('executionId') executionId: string): ReturnType<JobOperator['restart']> {
    return this.operator.restart(executionId);
  }

  @Post('executions/:executionId/abandon')
  abandon(@Param('executionId') executionId: string): ReturnType<JobOperator['abandon']> {
    return this.operator.abandon(executionId);
  }

  @Post('jobs/:jobId/start-next')
  startNextInstance(
    @Param('jobId') jobId: string,
    @Body() params: JobParameters = {},
  ): ReturnType<JobOperator['startNextInstance']> {
    return this.operator.startNextInstance(jobId, params);
  }
}
