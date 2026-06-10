import { describe, expect, it } from 'vitest';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '@nest-batch/core';

import { PostgresPrismaAdapter } from '../../src/prisma/postgres-prisma.adapter';
import { PostgresPrismaBatchModule } from '../../src/prisma/postgres-prisma.module';
import { PostgresPrismaJobRepository } from '../../src/prisma/postgres-prisma-job-repository';
import { PostgresPrismaTransactionManager } from '../../src/prisma/postgres-prisma-transaction-manager';

describe('PostgresPrismaAdapter — shape', () => {
  const adapter = PostgresPrismaAdapter.forRoot();

  it('returns a BatchAdapter whose name is "postgres-prisma"', () => {
    expect(adapter.name).toBe('postgres-prisma');
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

  it('preserves the host class identity: module.module === PostgresPrismaBatchModule', () => {
    expect(adapter.module.module).toBe(PostgresPrismaBatchModule);
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
      PostgresPrismaJobRepository,
      PostgresPrismaTransactionManager,
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
      useExisting: PostgresPrismaJobRepository,
    });
    expect(useExistingProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useExisting: PostgresPrismaTransactionManager,
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
      useClass: PostgresPrismaJobRepository,
    });
    expect(useClassProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: PostgresPrismaTransactionManager,
    });
  });

  it('does NOT include PrismaModule.forRoot in module.imports (structural invariant)', () => {
    expect(adapter.module.imports).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(adapter.module, 'imports')).toBe(
      false,
    );
  });
});
