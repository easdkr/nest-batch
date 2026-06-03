import { describe, it, expect } from 'vitest';
import {
  ItemReader,
  ItemProcessor,
  ItemWriter,
  Tasklet,
  TaskletContext,
} from '../../../src/core/item/interfaces';

describe('item interfaces', () => {
  it('Test 1: each interface can be implemented with a simple class', () => {
    class MyReader implements ItemReader<number> {
      async read(): Promise<number | null> {
        return 1;
      }
    }
    class MyProcessor implements ItemProcessor<number, string> {
      async process(item: number): Promise<string | null | undefined> {
        return `n=${item}`;
      }
    }
    class MyWriter implements ItemWriter<number> {
      async write(items: number[]): Promise<void> {
        items.reduce((a, b) => a + b, 0);
      }
    }
    class MyTasklet implements Tasklet {
      async execute(_ctx: TaskletContext): Promise<unknown> {
        return 'done';
      }
    }

    const reader = new MyReader();
    const processor = new MyProcessor();
    const writer = new MyWriter();
    const tasklet = new MyTasklet();

    expect(typeof reader.read).toBe('function');
    expect(typeof processor.process).toBe('function');
    expect(typeof writer.write).toBe('function');
    expect(typeof tasklet.execute).toBe('function');
  });

  it('Test 2: null from read() is interpreted as EOF', async () => {
    class EofReader implements ItemReader<number> {
      async read(): Promise<number | null> {
        return null;
      }
    }

    const reader = new EofReader();
    const result = await reader.read();
    expect(result).toBeNull();
  });

  it('Test 3: null from process() is interpreted as filter', async () => {
    class FilterProcessor implements ItemProcessor<number, number> {
      async process(item: number): Promise<number | null | undefined> {
        return item % 2 === 0 ? null : item;
      }
    }

    const processor = new FilterProcessor();
    expect(await processor.process(2)).toBeNull();
    expect(await processor.process(3)).toBe(3);
  });

  it('Test 4: ItemWriter accepts an array', async () => {
    let received: number[] | null = null;
    class MyWriter implements ItemWriter<number> {
      async write(items: number[]): Promise<void> {
        received = items;
      }
    }

    const writer = new MyWriter();
    const batch = [1, 2, 3, 4, 5];
    await writer.write(batch);

    expect(received).toEqual(batch);
    expect(Array.isArray(received)).toBe(true);
  });

  it('Test 5: Tasklet has execute(ctx) signature', async () => {
    class MyTasklet implements Tasklet {
      async execute(_ctx: TaskletContext): Promise<unknown> {
        return 'done';
      }
    }

    const fakeCtx: TaskletContext = {
      jobExecutionId: 'job-1',
      stepExecutionId: 'step-1',
      getExecutionContext: async () => ({ data: null, version: 0 }),
      saveExecutionContext: async () => undefined,
    };

    const tasklet = new MyTasklet();
    const result = await tasklet.execute(fakeCtx);

    expect(result).toBe('done');
  });
});

describe('item interfaces re-exported from core barrel (compile-time)', () => {
  it('all 5 types are importable from @nest-batch/core', () => {
    const check: [
      import('../../../src/core').ItemReader<number> | undefined,
      import('../../../src/core').ItemProcessor<number, number> | undefined,
      import('../../../src/core').ItemWriter<number> | undefined,
      import('../../../src/core').Tasklet | undefined,
      import('../../../src/core').TaskletContext | undefined,
    ] = [undefined, undefined, undefined, undefined, undefined];
    expect(check.every((v) => v === undefined)).toBe(true);
  });
});
