import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  BATCH_JOB_METADATA,
  BATCH_STEP_METADATA,
  BATCH_TASKLET_METADATA,
  Jobable,
  Stepable,
  Tasklet,
} from '../../src/decorators';

describe('@Jobable', () => {
  it('attaches BATCH_JOB_METADATA with the given options on the class (id only)', () => {
    @Jobable({ id: 'foo' })
    class FooJob {}

    const meta = Reflect.getMetadata(BATCH_JOB_METADATA, FooJob);
    expect(meta).toEqual({ id: 'foo' });
  });

  it('attaches BATCH_JOB_METADATA with all three fields (id, restartable, allowDuplicateInstances)', () => {
    @Jobable({
      id: 'foo',
      restartable: true,
      allowDuplicateInstances: true,
    })
    class FooJobFull {}

    const meta = Reflect.getMetadata(BATCH_JOB_METADATA, FooJobFull);
    expect(meta).toEqual({
      id: 'foo',
      restartable: true,
      allowDuplicateInstances: true,
    });
  });

  it('class without @Jobable returns undefined metadata (failure case)', () => {
    class NotAJob {}
    const meta = Reflect.getMetadata(BATCH_JOB_METADATA, NotAJob);
    expect(meta).toBeUndefined();
  });
});

describe('@Stepable', () => {
  it('attaches BATCH_STEP_METADATA with the given options on the method (id only)', () => {
    class FooJob {
      @Stepable({ id: 'bar' })
      bar() {}
    }

    const meta = Reflect.getMetadata(BATCH_STEP_METADATA, FooJob.prototype, 'bar');
    expect(meta).toEqual({ id: 'bar' });
  });

  it('attaches BATCH_STEP_METADATA including chunkSize when provided', () => {
    class FooJob {
      @Stepable({ id: 'bar', chunkSize: 10 })
      bar() {}
    }

    const meta = Reflect.getMetadata(BATCH_STEP_METADATA, FooJob.prototype, 'bar');
    expect(meta).toEqual({ id: 'bar', chunkSize: 10 });
  });
});

describe('@Tasklet', () => {
  it('attaches BATCH_TASKLET_METADATA flag = true on the method', () => {
    class FooJob {
      @Tasklet()
      bar() {}
    }

    const meta = Reflect.getMetadata(BATCH_TASKLET_METADATA, FooJob.prototype, 'bar');
    expect(meta).toBe(true);
  });
});

describe('@Stepable + @Tasklet combination', () => {
  it('attaches both BATCH_STEP_METADATA and BATCH_TASKLET_METADATA on the same method', () => {
    class FooJob {
      @Stepable({ id: 'bar' })
      @Tasklet()
      bar() {}
    }

    const stepMeta = Reflect.getMetadata(BATCH_STEP_METADATA, FooJob.prototype, 'bar');
    const taskletMeta = Reflect.getMetadata(BATCH_TASKLET_METADATA, FooJob.prototype, 'bar');

    expect(stepMeta).toEqual({ id: 'bar' });
    expect(taskletMeta).toBe(true);
  });
});
