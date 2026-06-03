import { describe, expect, test, vi } from 'vitest';
import { ListenerInvoker } from '../../src/execution/listener-invoker';

describe('ListenerInvoker skip-listener', () => {
  test('invokeOnSkipRead calls all on-skip:read resolvers in order', async () => {
    const invoker = new ListenerInvoker();
    const callOrder: string[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-skip:read:first',  { fn: () => { callOrder.push('first'); } });
    resolvers.set('on-skip:read:second', { fn: () => { callOrder.push('second'); } });
    await invoker.invokeOnSkipRead(resolvers, new Error('test'), { foo: 1 });
    expect(callOrder).toEqual(['first', 'second']);
  });

  test('skip listener throw propagates by default', async () => {
    const invoker = new ListenerInvoker();
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-skip:read:oops', { fn: () => { throw new Error('boom'); } });
    await expect(invoker.invokeOnSkipRead(resolvers, new Error('orig'), null)).rejects.toThrow('boom');
  });

  test('nonCritical skip listener does not propagate', async () => {
    const invoker = new ListenerInvoker();
    // silence the warning noise from the non-critical logger
    const warnSpy = vi
      .spyOn(
        (invoker as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    try {
      const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
      resolvers.set('on-skip:read:oops', {
        fn: () => {
          throw new Error('boom');
        },
        nonCritical: true,
      });
      await expect(invoker.invokeOnSkipRead(resolvers, new Error('orig'), null)).resolves.toBeUndefined();
      // and the non-critical failure was logged
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('invokeOnSkipProcess calls on-skip:process resolvers', async () => {
    const invoker = new ListenerInvoker();
    const calls: unknown[][] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-skip:process:logger', { fn: (...args) => { calls.push(args); } });
    await invoker.invokeOnSkipProcess(resolvers, { id: 1 }, new Error('x'));
    expect(calls.length).toBe(1);
    expect(calls[0]![1]).toBeInstanceOf(Error);
  });

  test('invokeOnSkipWrite calls on-skip:write resolvers', async () => {
    const invoker = new ListenerInvoker();
    const calls: unknown[][] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-skip:write:logger', { fn: (...args) => { calls.push(args); } });
    await invoker.invokeOnSkipWrite(resolvers, [{ id: 1 }, { id: 2 }], new Error('x'));
    expect(calls.length).toBe(1);
    expect((calls[0]![0] as unknown[]).length).toBe(2);
  });

  test('no skip resolvers is a no-op', async () => {
    const invoker = new ListenerInvoker();
    await expect(invoker.invokeOnSkipRead(new Map(), new Error('x'), null)).resolves.toBeUndefined();
    await expect(invoker.invokeOnSkipProcess(new Map(), null, new Error('x'))).resolves.toBeUndefined();
    await expect(invoker.invokeOnSkipWrite(new Map(), [], new Error('x'))).resolves.toBeUndefined();
  });
});
