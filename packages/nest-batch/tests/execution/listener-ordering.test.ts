import { describe, expect, test } from 'vitest';
import { ListenerInvoker } from '../../src/execution/listener-invoker';

describe('ListenerInvoker ordering', () => {
  test('2 before-step listeners invoked in registration order', async () => {
    const invoker = new ListenerInvoker();
    const callOrder: string[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('before:step:first',  { fn: () => { callOrder.push('first'); } });
    resolvers.set('before:step:second', { fn: () => { callOrder.push('second'); } });
    await invoker.invokeBefore(resolvers, 'step', { jobExecutionId: 'j1', stepExecutionId: 's1' });
    expect(callOrder).toEqual(['first', 'second']);
  });

  test('2 after-step listeners invoked in registration order', async () => {
    const invoker = new ListenerInvoker();
    const callOrder: string[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('after:step:alpha', { fn: () => { callOrder.push('alpha'); } });
    resolvers.set('after:step:beta',  { fn: () => { callOrder.push('beta'); } });
    await invoker.invokeAfter(resolvers, 'step', { jobExecutionId: 'j1', stepExecutionId: 's1' }, [{ status: 'COMPLETED' }]);
    expect(callOrder).toEqual(['alpha', 'beta']);
  });

  test('onError not called if no error (afterStep only)', async () => {
    const invoker = new ListenerInvoker();
    const onErrorCalls: unknown[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-error:step:oops', { fn: (...args) => { onErrorCalls.push(args); } });
    resolvers.set('after:step:done',   { fn: () => {} });
    // Just call after — should not invoke on-error
    await invoker.invokeAfter(resolvers, 'step', { jobExecutionId: 'j1', stepExecutionId: 's1' }, [{ status: 'COMPLETED' }]);
    expect(onErrorCalls).toEqual([]);
  });

  test('full sequence: beforeJob → beforeStep → afterStep → afterJob', async () => {
    const invoker = new ListenerInvoker();
    const callOrder: string[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('before:job:start',  { fn: () => { callOrder.push('beforeJob'); } });
    resolvers.set('after:job:finish',  { fn: () => { callOrder.push('afterJob'); } });
    resolvers.set('before:step:s',     { fn: () => { callOrder.push('beforeStep'); } });
    resolvers.set('after:step:s',      { fn: () => { callOrder.push('afterStep'); } });

    const ctx = { jobExecutionId: 'j1', stepExecutionId: 's1' };
    await invoker.invokeBefore(resolvers, 'job', ctx);
    await invoker.invokeBefore(resolvers, 'step', ctx);
    await invoker.invokeAfter(resolvers, 'step', ctx, [{ status: 'COMPLETED' }]);
    await invoker.invokeAfter(resolvers, 'job', ctx, [{ status: 'COMPLETED' }]);
    expect(callOrder).toEqual(['beforeJob', 'beforeStep', 'afterStep', 'afterJob']);
  });

  test('2 on-skip-read listeners in registration order', async () => {
    const invoker = new ListenerInvoker();
    const callOrder: string[] = [];
    const resolvers = new Map<string, { fn: (...args: unknown[]) => unknown; nonCritical?: boolean }>();
    resolvers.set('on-skip:read:logger1', { fn: () => { callOrder.push('logger1'); } });
    resolvers.set('on-skip:read:logger2', { fn: () => { callOrder.push('logger2'); } });
    await invoker.invokeOnSkipRead(resolvers, new Error('x'), null);
    expect(callOrder).toEqual(['logger1', 'logger2']);
  });
});
