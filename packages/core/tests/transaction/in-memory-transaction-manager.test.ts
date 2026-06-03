import { describe, expect, test } from 'vitest';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';

describe('InMemoryTransactionManager', () => {
  test('withTransaction calls fn with a valid context (isActive=true, id is non-empty string)', async () => {
    const tx = new InMemoryTransactionManager();
    let receivedCtx: unknown = null;
    await tx.withTransaction(async (ctx) => {
      receivedCtx = ctx;
    });

    expect(receivedCtx).not.toBeNull();
    const ctx = receivedCtx as { isActive: boolean; id: string };
    expect(ctx.isActive).toBe(true);
    expect(typeof ctx.id).toBe('string');
    expect(ctx.id.length).toBeGreaterThan(0);
  });

  test('withTransaction propagates errors thrown by fn', async () => {
    const tx = new InMemoryTransactionManager();
    const err = new Error('boom');

    await expect(
      tx.withTransaction(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  test('nested withTransaction calls both fns and returns the inner result (no rollback semantics)', async () => {
    const tx = new InMemoryTransactionManager();
    const callOrder: string[] = [];

    const result = await tx.withTransaction(async () => {
      callOrder.push('outer');
      const inner = await tx.withTransaction(async () => {
        callOrder.push('inner');
        return 'inner-value';
      });
      callOrder.push('after-inner');
      return inner;
    });

    expect(callOrder).toEqual(['outer', 'inner', 'after-inner']);
    expect(result).toBe('inner-value');
  });

  test('withTransaction returns the value resolved by fn', async () => {
    const tx = new InMemoryTransactionManager();
    const result = await tx.withTransaction(async () => ({ ok: true, n: 42 }));
    expect(result).toEqual({ ok: true, n: 42 });
  });

  test('two distinct withTransaction invocations produce different context IDs (fresh UUID per call)', async () => {
    const tx = new InMemoryTransactionManager();
    const ids = new Set<string>();

    for (let i = 0; i < 5; i++) {
      await tx.withTransaction(async (ctx) => {
        ids.add(ctx.id);
      });
    }

    expect(ids.size).toBe(5);
    for (const id of ids) {
      // v4 UUID format
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
