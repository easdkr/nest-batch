import { describe, expect, test, vi } from 'vitest';
import {
  ListenerInvoker,
  type ListenerEntry,
  type ListenerContext,
  type ResolverMap,
  type ListenerResolver,
  type StepListenerContext,
} from '../../src/execution/listener-invoker';

/** Convenience: build a ResolverMap from a list of [key, entry] pairs. */
function makeResolver(entries: Array<[string, ListenerEntry]>): ResolverMap {
  return new Map(entries);
}

/** Shared context used throughout the suite. */
const ctx: ListenerContext = {
  jobExecutionId: 'job-exec-1',
  stepExecutionId: 'step-exec-1',
  stepName: 'my-step',
};

describe('ListenerInvoker', () => {
  // ---------------------------------------------------------------------------
  // Phase dispatch — Test 1–5
  // ---------------------------------------------------------------------------

  test('1) invokeBefore calls all `before:step:*` listeners in registration order', async () => {
    const order: string[] = [];
    const invoker = new ListenerInvoker();
    const resolvers = makeResolver([
      ['before:step:first', { fn: () => void order.push('first') }],
      ['before:step:second', { fn: () => void order.push('second') }],
      ['before:step:third', { fn: () => void order.push('third') }],
      // non-matching phase should be ignored
      ['before:job:ignored', { fn: () => void order.push('IGNORED') }],
      ['after:step:ignored', { fn: () => void order.push('IGNORED') }],
    ]);

    await invoker.invokeBefore(resolvers, 'step', ctx);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('2) invokeAfter calls all `after:step:*` listeners in registration order', async () => {
    const order: string[] = [];
    const invoker = new ListenerInvoker();
    const resolvers = makeResolver([
      ['after:step:a', { fn: () => void order.push('a') }],
      ['after:step:b', { fn: () => void order.push('b') }],
      // non-matching phase should be ignored
      ['after:job:ignored', { fn: () => void order.push('IGNORED') }],
      ['on-skip:read:ignored', { fn: () => void order.push('IGNORED') }],
    ]);
    const result = { status: 'COMPLETED', exitCode: 'COMPLETED', exitMessage: 'OK' };

    await invoker.invokeAfter(resolvers, 'step', ctx, result);

    expect(order).toEqual(['a', 'b']);
  });

  test('3) invokeOnError calls all `on-error:step:*` with (ctx, err)', async () => {
    const calls: Array<{ ctx: unknown; err: unknown }> = [];
    const invoker = new ListenerInvoker();
    const err = new Error('boom');
    const resolvers = makeResolver([
      [
        'on-error:step:observer',
        { fn: (c: unknown, e: unknown) => void calls.push({ ctx: c, err: e }) },
      ],
      // wrong phase / wrong kind → ignored
      ['on-error:job:ignored', { fn: () => void calls.push({ ctx: 'IGNORED', err: 'IGNORED' }) }],
      ['before:step:ignored', { fn: () => void calls.push({ ctx: 'IGNORED', err: 'IGNORED' }) }],
    ]);

    await invoker.invokeOnError(resolvers, 'step', ctx, err);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctx).toBe(ctx);
    expect(calls[0]?.err).toBe(err);
  });

  test('4) invokeBefore for kind=job only calls `before:job:*` listeners (step listeners are ignored)', async () => {
    const order: string[] = [];
    const invoker = new ListenerInvoker();
    const resolvers = makeResolver([
      ['before:job:J1', { fn: () => void order.push('J1') }],
      ['before:job:J2', { fn: () => void order.push('J2') }],
      // step, chunk, and item-* should all be filtered out
      ['before:step:S1', { fn: () => void order.push('IGNORED') }],
      ['before:chunk:C1', { fn: () => void order.push('IGNORED') }],
      ['before:item-read:R1', { fn: () => void order.push('IGNORED') }],
      ['before:item-process:P1', { fn: () => void order.push('IGNORED') }],
      ['before:item-write:W1', { fn: () => void order.push('IGNORED') }],
    ]);

    await invoker.invokeBefore(resolvers, 'job', ctx);

    expect(order).toEqual(['J1', 'J2']);
  });

  test('5) invokeBefore for kind=step only calls `before:step:*` listeners (job, chunk, item-* ignored)', async () => {
    const order: string[] = [];
    const invoker = new ListenerInvoker();
    const resolvers = makeResolver([
      ['before:step:S1', { fn: () => void order.push('S1') }],
      ['before:step:S2', { fn: () => void order.push('S2') }],
      ['before:job:J1', { fn: () => void order.push('IGNORED') }],
      ['before:chunk:C1', { fn: () => void order.push('IGNORED') }],
      ['before:item-read:R1', { fn: () => void order.push('IGNORED') }],
      ['before:item-process:P1', { fn: () => void order.push('IGNORED') }],
      ['before:item-write:W1', { fn: () => void order.push('IGNORED') }],
    ]);

    await invoker.invokeBefore(resolvers, 'step', ctx);

    expect(order).toEqual(['S1', 'S2']);
  });

  // ---------------------------------------------------------------------------
  // Failure policy — Test 6–7
  // ---------------------------------------------------------------------------

  test('6) default policy: a listener throw propagates and aborts the invocation', async () => {
    const invoker = new ListenerInvoker();
    const calls: string[] = [];
    const err = new Error('critical-boom');
    const resolvers = makeResolver([
      ['before:step:first', { fn: () => void calls.push('first') }],
      // throws on the second listener — default (non-critical)
      [
        'before:step:throws',
        { fn: () => { calls.push('throws'); throw err; } },
      ],
      // never reached
      ['before:step:third', { fn: () => void calls.push('third') }],
    ]);

    await expect(invoker.invokeBefore(resolvers, 'step', ctx)).rejects.toBe(err);
    expect(calls).toEqual(['first', 'throws']);
  });

  test('7) nonCritical: true → listener throw is logged and the next listener still runs', async () => {
    const invoker = new ListenerInvoker();
    // silence the warning noise from the non-critical logger
    const warnSpy = vi.spyOn((invoker as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn').mockImplementation(() => undefined);
    try {
      const calls: string[] = [];
      const resolvers = makeResolver([
        ['before:step:first', { fn: () => void calls.push('first') }],
        [
          'before:step:boom',
          { fn: () => { calls.push('boom'); throw new Error('non-critical-boom'); }, nonCritical: true },
        ],
        ['before:step:third', { fn: () => void calls.push('third') }],
      ]);

      // should NOT throw
      await expect(invoker.invokeBefore(resolvers, 'step', ctx)).resolves.toBeUndefined();

      // all three listeners ran
      expect(calls).toEqual(['first', 'boom', 'third']);
      // and the non-critical failure was logged
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('non-critical listener "before:step:boom" failed');
      expect(msg).toContain('non-critical-boom');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Legacy convenience — Test 8
  // ---------------------------------------------------------------------------

  test('8) legacy convenience methods (invokeBeforeStep / invokeAfterStep / invokeOnErrorStep) still work', async () => {
    const invoker = new ListenerInvoker();
    const order: string[] = [];

    // The legacy shape: `Map<string, ListenerResolver>` (bare function value)
    // and keys like `before-step:`, `after-step:`, `on-step-error:`.
    const legacyResolvers = new Map<string, ListenerResolver>();
    legacyResolvers.set('before-step:b', async () => { order.push('before'); });
    legacyResolvers.set('after-step:a', async () => { order.push('after'); });
    legacyResolvers.set('on-step-error:e', async (_c, err) => { order.push(`onError:${(err as Error).message}`); });
    // a non-matching phase key should be ignored
    legacyResolvers.set('before-job:ignored', async () => { order.push('IGNORED'); });
    legacyResolvers.set('chunk-listener:ignored', async () => { order.push('IGNORED'); });

    const stepCtx: StepListenerContext = {
      jobExecutionId: 'job-exec-1',
      stepExecutionId: 'step-exec-1',
    };
    const result = { status: 'COMPLETED', exitCode: 'COMPLETED', exitMessage: 'OK' };

    await invoker.invokeBeforeStep(legacyResolvers, stepCtx);
    await invoker.invokeAfterStep(legacyResolvers, stepCtx, result);
    await invoker.invokeOnErrorStep(legacyResolvers, stepCtx, new Error('explode'));

    expect(order).toEqual([
      'before',
      'after',
      'onError:explode',
    ]);
  });

  // ---------------------------------------------------------------------------
  // Skip variants — Test 9–10
  // ---------------------------------------------------------------------------

  test('9) invokeOnSkipRead calls `on-skip:read:*` resolvers with (err, item) in order', async () => {
    const invoker = new ListenerInvoker();
    const calls: Array<{ err: unknown; item: unknown }> = [];
    const err = new Error('read-fail');
    const item = { id: 42, value: 'oops' };
    const resolvers = makeResolver([
      [
        'on-skip:read:first',
        { fn: (e: unknown, i: unknown) => void calls.push({ err: e, item: i }) },
      ],
      [
        'on-skip:read:second',
        { fn: (e: unknown, i: unknown) => void calls.push({ err: e, item: i }) },
      ],
      // wrong sub-kind → ignored
      ['on-skip:process:ignored', { fn: () => void calls.push({ err: 'IGNORED', item: 'IGNORED' }) }],
      ['on-skip:write:ignored', { fn: () => void calls.push({ err: 'IGNORED', item: 'IGNORED' }) }],
    ]);

    await invoker.invokeOnSkipRead(resolvers, err, item);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ err, item });
    expect(calls[1]).toEqual({ err, item });
  });

  test('10) invokeOnSkipProcess calls `on-skip:process:*` resolvers with (item, err); invokeOnSkipWrite with (items, err)', async () => {
    const invoker = new ListenerInvoker();
    const processCalls: Array<{ item: unknown; err: unknown }> = [];
    const writeCalls: Array<{ items: unknown[]; err: unknown }> = [];

    const item = { id: 1, name: 'alpha' };
    const err = new Error('process-fail');
    const items = [item, { id: 2, name: 'beta' }];
    const writeErr = new Error('write-fail');

    // Negative keys use non-matching phases (`on-error:*`, `before:*`) so
    // the prefix filter rejects them. `on-skip:process:*` and `on-skip:write:*`
    // would also start with the other skip sub-kind's prefix, so they are
    // deliberately avoided.
    const resolvers = makeResolver([
      [
        'on-skip:process:trace',
        { fn: (i: unknown, e: unknown) => void processCalls.push({ item: i, err: e }) },
      ],
      ['on-error:step:neg-for-process', { fn: () => void processCalls.push({ item: 'IGNORED', err: 'IGNORED' }) }],
      ['before:step:neg-for-process', { fn: () => void processCalls.push({ item: 'IGNORED', err: 'IGNORED' }) }],

      [
        'on-skip:write:trace',
        { fn: (its: unknown[], e: unknown) => void writeCalls.push({ items: its, err: e }) },
      ],
      ['on-error:step:neg-for-write', { fn: () => void writeCalls.push({ items: ['IGNORED'], err: 'IGNORED' }) }],
      ['before:step:neg-for-write', { fn: () => void writeCalls.push({ items: ['IGNORED'], err: 'IGNORED' }) }],
    ]);

    await invoker.invokeOnSkipProcess(resolvers, item, err);
    await invoker.invokeOnSkipWrite(resolvers, items, writeErr);

    expect(processCalls).toEqual([{ item, err }]);
    expect(writeCalls).toEqual([{ items, err: writeErr }]);
  });
});
