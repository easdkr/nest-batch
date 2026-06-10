import { describe, expect, it } from 'vitest';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '@nest-batch/core';

import { PostgresDrizzleAdapter } from '../../src/drizzle/postgres-drizzle.adapter';
import { PostgresDrizzleBatchModule } from '../../src/drizzle/postgres-drizzle.module';
import { PostgresDrizzleJobRepository } from '../../src/drizzle/postgres-drizzle-job-repository';
import { PostgresDrizzleTransactionManager } from '../../src/drizzle/postgres-drizzle-transaction-manager';

/**
 * Shape test for `PostgresDrizzleAdapter` — the PostgreSQL driver
 * shell that pairs `@nest-batch/drizzle` (the slot) with
 * `drizzle-orm/node-postgres` + `drizzle-orm/pg-core` (the driver
 * binding owned by `@nest-batch/postgresql`).
 *
 * Mirrors `packages/drizzle/tests/adapter-shape.test.ts` exactly:
 * the assertions on the `BatchAdapter` shape (name, module literal,
 * global flag, 4 providers, 2 exports, 2 globalProviders) are the
 * same; only the adapter identity / class names / module path are
 * the Postgres-flavored ones.
 *
 * The slot's `DrizzleAdapter.forRoot()` and the driver's
 * `PostgresDrizzleAdapter.forRoot()` must produce the same shape
 * — they are both `BatchAdapter` values and a host that swaps
 * one for the other must see identical wiring behavior.
 */
describe('PostgresDrizzleAdapter — shape', () => {
  const adapter = PostgresDrizzleAdapter.forRoot();

  it('returns a BatchAdapter whose name is "postgres-drizzle"', () => {
    expect(adapter.name).toBe('postgres-drizzle');
  });

  it('exposes a `module` field that is a DynamicModule literal', () => {
    expect(adapter).toHaveProperty('module');
    expect(typeof adapter.module).toBe('object');
    expect(adapter.module).not.toBeNull();
    expect('module' in adapter.module).toBe(true);
    expect('global' in adapter.module).toBe(true);
    expect('providers' in adapter.module).toBe(true);
    expect('exports' in adapter.module).toBe(true);
  });

  it('preserves the host class identity: module.module === PostgresDrizzleBatchModule', () => {
    expect(adapter.module.module).toBe(PostgresDrizzleBatchModule);
  });

  it('omits the `imports` key entirely (undefined — not [])', () => {
    expect(adapter.module.imports).toBeUndefined();
  });

  it('is registered as a global module (module.global === true)', () => {
    expect(adapter.module.global).toBe(true);
  });

  it('declares exactly 4 providers: the two classes plus the two useExisting token bindings', () => {
    expect(Array.isArray(adapter.module.providers)).toBe(true);
    expect(adapter.module.providers).toHaveLength(4);

    const providers = adapter.module.providers as Array<unknown>;
    const classProviders = providers.filter(
      (p) => typeof p === 'function',
    );
    expect(classProviders).toEqual([
      PostgresDrizzleJobRepository,
      PostgresDrizzleTransactionManager,
    ]);

    const useExistingProviders = providers.filter(
      (p): p is { provide: any; useExisting: any } =>
        typeof p === 'object' &&
        p !== null &&
        'useExisting' in p &&
        !('useClass' in p) &&
        !('useFactory' in p) &&
        !('useValue' in p),
    );
    expect(useExistingProviders).toHaveLength(2);
    expect(useExistingProviders).toContainEqual({
      provide: JOB_REPOSITORY_TOKEN,
      useExisting: PostgresDrizzleJobRepository,
    });
    expect(useExistingProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useExisting: PostgresDrizzleTransactionManager,
    });
  });

  it('exports exactly 2 tokens: JOB_REPOSITORY_TOKEN and TRANSACTION_MANAGER_TOKEN', () => {
    expect(Array.isArray(adapter.module.exports)).toBe(true);
    expect(adapter.module.exports).toHaveLength(2);
    expect(adapter.module.exports).toEqual([
      JOB_REPOSITORY_TOKEN,
      TRANSACTION_MANAGER_TOKEN,
    ]);
  });

  it('exposes a `globalProviders` array of length 2', () => {
    expect(Array.isArray(adapter.globalProviders)).toBe(true);
    expect(adapter.globalProviders).toHaveLength(2);

    const useClassProviders = (adapter.globalProviders as Array<unknown>).filter(
      (p): p is { provide: any; useClass: any } =>
        typeof p === 'object' &&
        p !== null &&
        'useClass' in p &&
        !('useExisting' in p) &&
        !('useFactory' in p) &&
        !('useValue' in p),
    );
    expect(useClassProviders).toHaveLength(2);
    expect(useClassProviders).toContainEqual({
      provide: JOB_REPOSITORY_TOKEN,
      useClass: PostgresDrizzleJobRepository,
    });
    expect(useClassProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: PostgresDrizzleTransactionManager,
    });
  });

  it('does NOT include DrizzleModule in module.imports (structural invariant)', () => {
    expect(adapter.module.imports).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(adapter.module, 'imports')).toBe(
      false,
    );
  });
});
