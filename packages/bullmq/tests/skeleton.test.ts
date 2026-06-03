/**
 * Smoke test for the @nest-batch/bullmq package skeleton.
 *
 * Verifies the three contracts the T17 deliverable commits to:
 *
 *   1. `BullMqExecutionStrategy` is a valid `IExecutionStrategy`
 *      (`name` is set, `launch()` is callable and returns a
 *      `LaunchResult`).
 *   2. The stub `launch()` returns `{ kind: 'completed', status:
 *      'COMPLETED' }` without ever touching BullMQ — no `Queue`,
 *      no `Worker`, no Redis I/O. The test runs in milliseconds
 *      and is hermetic (no `docker compose up redis` required).
 *   3. The `BullmqBatchModule.forRoot()` factory returns a
 *      `DynamicModule` that:
 *        - is `global: true` (matches `NestBatchModule`),
 *        - provides `BullMqExecutionStrategy` as a class provider,
 *        - provides an `EXECUTION_STRATEGY` binding via
 *          `useExisting: BullMqExecutionStrategy` so the
 *          `JobLauncher`'s `@Inject(EXECUTION_STRATEGY)` resolves
 *          to the same instance,
 *        - exposes the resolved options under
 *          `BULLMQ_MODULE_OPTIONS`.
 *
 * The actual Nest-container wiring (i.e. that the launcher + the
 * strategy + the executor can all be constructed in a single
 * `Test.createTestingModule(...)`) is intentionally out of scope
 * for T17 — it is exercised by the dedicated Nest-container test
 * planned for T18 once `JobExecutor` and the repository are part
 * of the same module graph. Today, the dependency is asymmetric
 * (the strategy is a stub that takes no other collaborators), so
 * the wiring is trivial to assert from the `DynamicModule` shape
 * alone.
 */

import { describe, it, expect } from 'vitest';

import { EXECUTION_STRATEGY, type LaunchResult } from '@nest-batch/core';

import { BullMqExecutionStrategy } from '../src/bullmq-execution-strategy';
import { BullmqBatchModule } from '../src/bullmq-batch.module';
import { BULLMQ_MODULE_OPTIONS } from '../src/module-options';
import {
  resolveBullMqConnection,
  BULLMQ_DEFAULT_HOST,
  BULLMQ_DEFAULT_KEY_PREFIX,
} from '../src/connection';

describe('@nest-batch/bullmq skeleton smoke', () => {
  describe('BullMqExecutionStrategy (T17 stub)', () => {
    it('is constructable without a Nest container (no required deps)', () => {
      const strategy = new BullMqExecutionStrategy(undefined);
      expect(strategy).toBeInstanceOf(BullMqExecutionStrategy);
    });

    it("exposes a stable `name` so log lines can tell the stub from the T18 runtime", () => {
      const strategy = new BullMqExecutionStrategy(undefined);
      expect(strategy.name).toBe('bullmq-stub');
    });

    it('launch() returns a LaunchResult without touching BullMQ or Redis', async () => {
      const strategy = new BullMqExecutionStrategy(undefined);
      const result: LaunchResult = await strategy.launch(
        // The stub deliberately ignores the inputs, so the literals
        // below are the minimum shapes the type requires.
        {} as never,
        {} as never,
        // The launcher passes the execution / jobExecution ids in
        // ctx; the stub does not read them.
        { executionId: 'exec-1', jobExecutionId: 'exec-1' },
      );
      expect(result).toEqual({ kind: 'completed', status: 'COMPLETED' });
    });
  });

  describe('resolveBullMqConnection()', () => {
    it('fills in defaults when no options are passed', () => {
      const resolved = resolveBullMqConnection(undefined);
      expect(resolved).toEqual({
        host: BULLMQ_DEFAULT_HOST,
        port: 6379,
        password: undefined,
        username: undefined,
        db: 0,
        keyPrefix: BULLMQ_DEFAULT_KEY_PREFIX,
        tls: false,
      });
    });

    it('honours caller-supplied overrides', () => {
      const resolved = resolveBullMqConnection({
        host: 'redis.internal',
        port: 6390,
        password: 'secret',
        keyPrefix: 'tenant-a:',
        tls: true,
      });
      expect(resolved).toEqual({
        host: 'redis.internal',
        port: 6390,
        password: 'secret',
        username: undefined,
        db: 0,
        keyPrefix: 'tenant-a:',
        tls: true,
      });
    });

    it('returns a frozen object so callers cannot mutate the resolved options', () => {
      const resolved = resolveBullMqConnection(undefined);
      expect(Object.isFrozen(resolved)).toBe(true);
    });
  });

  describe('BullmqBatchModule.forRoot()', () => {
    it('returns a global DynamicModule', () => {
      const mod = BullmqBatchModule.forRoot();
      expect(mod.global).toBe(true);
      expect(mod.module).toBe(BullmqBatchModule);
    });

    it('registers BullMqExecutionStrategy as a class provider', () => {
      const mod = BullmqBatchModule.forRoot();
      expect(mod.providers).toContain(BullMqExecutionStrategy);
    });

    it('binds EXECUTION_STRATEGY to BullMqExecutionStrategy via useExisting', () => {
      const mod = BullmqBatchModule.forRoot();
      const tokenBinding = (mod.providers as Array<Record<string, unknown>>).find(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          p['provide'] === EXECUTION_STRATEGY,
      );
      expect(tokenBinding).toBeDefined();
      expect(tokenBinding).toMatchObject({
        provide: EXECUTION_STRATEGY,
        useExisting: BullMqExecutionStrategy,
      });
    });

    it('exposes the resolved options under BULLMQ_MODULE_OPTIONS', () => {
      const mod = BullmqBatchModule.forRoot({
        connection: { host: '10.0.0.1', port: 6380, keyPrefix: 'app:' },
        autoStartWorker: true,
      });
      const optsProvider = (mod.providers as Array<Record<string, unknown>>).find(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          'provide' in p &&
          p['provide'] === BULLMQ_MODULE_OPTIONS,
      );
      expect(optsProvider).toBeDefined();
      const useValue = optsProvider!['useValue'] as {
        connection: { host: string; port: number; keyPrefix: string };
        autoStartWorker: boolean;
      };
      expect(useValue.connection.host).toBe('10.0.0.1');
      expect(useValue.connection.port).toBe(6380);
      expect(useValue.connection.keyPrefix).toBe('app:');
      expect(useValue.autoStartWorker).toBe(true);
      expect(Object.isFrozen(useValue)).toBe(true);
      expect(Object.isFrozen(useValue.connection)).toBe(true);
    });

    it('exports EXECUTION_STRATEGY, BULLMQ_MODULE_OPTIONS, and BullMqExecutionStrategy', () => {
      const mod = BullmqBatchModule.forRoot();
      expect(mod.exports).toContain(EXECUTION_STRATEGY);
      expect(mod.exports).toContain(BULLMQ_MODULE_OPTIONS);
      expect(mod.exports).toContain(BullMqExecutionStrategy);
    });
  });
});
