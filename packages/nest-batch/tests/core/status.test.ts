import { describe, it, expect } from 'vitest';
import {
  JobStatus,
  StepStatus,
  FlowExecutionStatus,
  ChunkStatus,
} from '../../src/core/status';
import * as core from '../../src/core';

describe('Status enums', () => {
  describe('JobStatus', () => {
    it('STARTING === "STARTING"', () => {
      expect(JobStatus.STARTING).toBe('STARTING');
    });
    it('STARTED === "STARTED"', () => {
      expect(JobStatus.STARTED).toBe('STARTED');
    });
    it('COMPLETED === "COMPLETED"', () => {
      expect(JobStatus.COMPLETED).toBe('COMPLETED');
    });
    it('FAILED === "FAILED"', () => {
      expect(JobStatus.FAILED).toBe('FAILED');
    });
    it('STOPPING === "STOPPING"', () => {
      expect(JobStatus.STOPPING).toBe('STOPPING');
    });
    it('STOPPED === "STOPPED"', () => {
      expect(JobStatus.STOPPED).toBe('STOPPED');
    });
    it('UNKNOWN === "UNKNOWN"', () => {
      expect(JobStatus.UNKNOWN).toBe('UNKNOWN');
    });
  });

  describe('StepStatus', () => {
    it('STARTING === "STARTING"', () => {
      expect(StepStatus.STARTING).toBe('STARTING');
    });
    it('STARTED === "STARTED"', () => {
      expect(StepStatus.STARTED).toBe('STARTED');
    });
    it('COMPLETED === "COMPLETED"', () => {
      expect(StepStatus.COMPLETED).toBe('COMPLETED');
    });
    it('FAILED === "FAILED"', () => {
      expect(StepStatus.FAILED).toBe('FAILED');
    });
    it('STOPPED === "STOPPED"', () => {
      expect(StepStatus.STOPPED).toBe('STOPPED');
    });
    it('UNKNOWN === "UNKNOWN"', () => {
      expect(StepStatus.UNKNOWN).toBe('UNKNOWN');
    });
  });

  describe('FlowExecutionStatus', () => {
    it('COMPLETED === "COMPLETED"', () => {
      expect(FlowExecutionStatus.COMPLETED).toBe('COMPLETED');
    });
    it('FAILED === "FAILED"', () => {
      expect(FlowExecutionStatus.FAILED).toBe('FAILED');
    });
    it('STOPPED === "STOPPED"', () => {
      expect(FlowExecutionStatus.STOPPED).toBe('STOPPED');
    });
    it('UNKNOWN === "UNKNOWN"', () => {
      expect(FlowExecutionStatus.UNKNOWN).toBe('UNKNOWN');
    });
  });

  describe('ChunkStatus', () => {
    it('PROCESSING === "PROCESSING"', () => {
      expect(ChunkStatus.PROCESSING).toBe('PROCESSING');
    });
    it('COMPLETED === "COMPLETED"', () => {
      expect(ChunkStatus.COMPLETED).toBe('COMPLETED');
    });
  });
});

describe('core barrel re-exports', () => {
  it('re-exports JobStatus from core/index', () => {
    expect(core.JobStatus).toBeDefined();
    expect(core.JobStatus.STARTING).toBe('STARTING');
    expect(core.JobStatus.COMPLETED).toBe('COMPLETED');
  });
  it('re-exports StepStatus from core/index', () => {
    expect(core.StepStatus).toBeDefined();
    expect(core.StepStatus.STARTING).toBe('STARTING');
  });
  it('re-exports FlowExecutionStatus from core/index', () => {
    expect(core.FlowExecutionStatus).toBeDefined();
    expect(core.FlowExecutionStatus.COMPLETED).toBe('COMPLETED');
  });
  it('re-exports ChunkStatus from core/index', () => {
    expect(core.ChunkStatus).toBeDefined();
    expect(core.ChunkStatus.PROCESSING).toBe('PROCESSING');
  });
});
