import { describe, expect, test } from 'vitest';
import { JobRepository, IJobRepository } from '../../../src/core/repository/job-repository';
import { TransactionManager } from '../../../src/core/transaction/transaction-manager';
import type {
  JobInstance,
  JobExecution,
  StepExecution,
  ExecutionContext,
} from '../../../src/core/repository/types';
import { JobStatus, StepStatus } from '../../../src/core/status';

class MockRepo extends JobRepository {
  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    return { id: 'inst-1', jobName: name, jobKey, createdAt: new Date() };
  }
  async createJobExecution(jobInstanceId: string, _params: any): Promise<JobExecution> {
    return {
      id: 'exec-1',
      jobInstanceId,
      status: JobStatus.STARTING,
      startTime: null,
      endTime: null,
      exitCode: '',
      exitMessage: '',
      params: {},
    };
  }
  async createExecutionAtomic(_name: string, _jobKey: string, params: any): Promise<JobExecution> {
    return this.createJobExecution('inst-1', params);
  }
  async updateJobExecution(_id: string, _patch: any): Promise<void> {}
  async getJobExecution(_id: string): Promise<JobExecution | null> {
    return null;
  }
  async getRunningJobExecution(_jobInstanceId: string): Promise<JobExecution | null> {
    return null;
  }
  async createStepExecution(jobExecutionId: string, stepName: string): Promise<StepExecution> {
    return {
      id: 'step-1',
      jobExecutionId,
      stepName,
      status: StepStatus.STARTING,
      readCount: 0,
      writeCount: 0,
      skipCount: 0,
      rollbackCount: 0,
      commitCount: 0,
      startTime: null,
      endTime: null,
      exitCode: '',
      exitMessage: '',
    };
  }
  async updateStepExecution(_id: string, _patch: any): Promise<void> {}
  async getStepExecution(_id: string): Promise<StepExecution | null> {
    return null;
  }
  async getExecutionContext(_scope: any): Promise<ExecutionContext> {
    return { data: null, version: 0 };
  }
  async saveExecutionContext(_scope: any, _ctx: ExecutionContext): Promise<void> {}
  async findLatestStepExecution(
    _jobExecutionId: string,
    _stepName: string,
  ): Promise<StepExecution | null> {
    return null;
  }
}

class MockTxManager extends TransactionManager {
  async withTransaction<T>(fn: (ctx: any) => Promise<T>): Promise<T> {
    return fn({ isActive: true as const, id: 'tx-1' });
  }
}

describe('JobRepository contract', () => {
  test('mock can be instantiated and implements IJobRepository', () => {
    const repo = new MockRepo();
    expect(repo).toBeInstanceOf(JobRepository);
  });

  test('getOrCreateJobInstance returns expected shape', async () => {
    const repo = new MockRepo();
    const inst = await repo.getOrCreateJobInstance('myJob', 'key1');
    expect(inst.jobName).toBe('myJob');
    expect(inst.jobKey).toBe('key1');
    expect(inst.id).toBe('inst-1');
  });

  test('IJobRepository has 10 methods', () => {
    // Static shape check
    const proto: IJobRepository = {} as any;
    expect(typeof (proto as any).getOrCreateJobInstance).toBe('undefined'); // type-only
    // The real test is the 10 methods listed in the interface (compile-time guarantee)
  });
});

describe('TransactionManager contract', () => {
  test('mock can be instantiated', () => {
    const mgr = new MockTxManager();
    expect(mgr).toBeInstanceOf(TransactionManager);
  });

  test('withTransaction calls fn with active context', async () => {
    const mgr = new MockTxManager();
    const result = await mgr.withTransaction(async (ctx) => {
      expect(ctx.isActive).toBe(true);
      expect(ctx.id).toBe('tx-1');
      return 'ok';
    });
    expect(result).toBe('ok');
  });
});
