/**
 * Pure-shape regression suite for `MikroOrmAdapter`.
 *
 * These tests pin the *structural* invariants of the adapter — the
 * exact shape of the `BatchAdapter` value `MikroOrmAdapter.forRoot()`
 * returns — without booting a `TestingModule`, opening a `MikroORM`
 * connection, or instantiating any of the provider classes.
 *
 * Why shape-only (and not the contract suite)?
 *   The shared `runJobRepositoryContract` suite (in
 *   `packages/mikro-orm/tests/contract.test.ts`) is the source of
 *   truth for *behavioral* invariants — `JobRepository` +
 *   `TransactionManager` semantics against a real database. This
 *   file is the source of truth for *structural* invariants:
 *
 *     - the adapter is named `'mikro-orm'`
 *     - the host module class identity is preserved
 *       (`MikroOrmAdapterModule`)
 *     - the module is a `global: true` `DynamicModule` literal
 *     - the `imports` key is **absent** (i.e. `undefined`, NOT
 *       `[]`) — the adapter is binding-only and does not bootstrap
 *       a `MikroOrmModule.forRoot()` call
 *     - the provider / export / `globalProviders` arrays have the
 *       exact counts expected (5 / 3 / 3)
 *
 *   A regression on any of these would slip past the contract
 *   suite (which compiles the module and exercises behavior) and
 *   quietly break the host's wiring. This file is the tripwire.
 *
 * No mocking, no DB, no `beforeAll` / `afterAll` — every assertion
 * is a pure synchronous object-shape check. If you find yourself
 * wanting to add one, the test belongs in `contract.test.ts`,
 * not here.
 */
import { describe, expect, it } from 'vitest';
import { JOB_REPOSITORY_TOKEN, TRANSACTION_MANAGER_TOKEN } from '@nest-batch/core';
import { EntityManager } from '@mikro-orm/core';

import { MikroOrmAdapter, MikroOrmAdapterModule } from '../src/adapters';
import { MikroOrmDriverProvider } from '../src/mikro-orm.driver-provider';
import { MikroORMJobRepository } from '../src/mikroorm-job-repository';
import { MikroORMTransactionManager } from '../src/mikroorm-transaction-manager';

describe('MikroOrmAdapter — shape (Task 12)', () => {
  // `forRoot()` is a pure factory with no arguments and no side
  // effects. Calling it once at the suite top keeps the shape
  // frozen across every `it` block — if anyone reorders or
  // re-instantiates the call site, the assertions below catch it.
  const adapter = MikroOrmAdapter.forRoot();

  it('returns a BatchAdapter whose name is "mikro-orm"', () => {
    expect(adapter.name).toBe('mikro-orm');
  });

  it('exposes a `module` field that is a DynamicModule literal (not a class, not a factory result)', () => {
    // A `DynamicModule` literal is a plain object whose `module`
    // property is a class reference. A class with a static
    // `forRoot()` would have `typeof === 'function'`; a Nest
    // `forRoot({ ... })` call would return the same object shape
    // but with an `imports` key — both are caught by the structural
    // assertions that follow.
    expect(adapter).toHaveProperty('module');
    expect(typeof adapter.module).toBe('object');
    expect(adapter.module).not.toBeNull();
    expect('module' in adapter.module).toBe(true);
    expect('global' in adapter.module).toBe(true);
    expect('providers' in adapter.module).toBe(true);
    expect('exports' in adapter.module).toBe(true);
  });

  it('preserves the host class identity: module.module === MikroOrmAdapterModule', () => {
    // The empty `MikroOrmAdapterModule` class is the module's host
    // identifier. If a refactor swaps it for an anonymous class
    // or for the `MikroOrmModule` class from `@mikro-orm/nestjs`,
    // the DI graph silently re-roots and the host app starts
    // seeing the wrong provider scope. Pin the class identity here.
    expect(adapter.module.module).toBe(MikroOrmAdapterModule);
  });

  it('omits the `imports` key entirely (undefined — not [])', () => {
    // The adapter is binding-only. It must NOT carry an `imports`
    // array (even an empty one) on its `DynamicModule`, because
    // an empty `imports: []` would still be picked up by Nest's
    // module-merge code path and any future addition would
    // silently re-introduce the MikroOrmModule.forRoot coupling
    // this refactor removed. The invariant is `undefined`, not
    // `[]`.
    expect(adapter.module.imports).toBeUndefined();
  });

  it('is registered as a global module (module.global === true)', () => {
    // The host's `MikroOrmModule.forRoot()` is the source of the
    // `EntityManager` / `MikroORM` injections. For those tokens
    // to be visible inside this adapter's module, the adapter's
    // module must be `global: true` — otherwise Nest's module
    // encapsulation hides them.
    expect(adapter.module.global).toBe(true);
  });

  it('declares exactly 5 providers: the two classes plus three useExisting token bindings', () => {
    expect(Array.isArray(adapter.module.providers)).toBe(true);
    expect(adapter.module.providers).toHaveLength(5);

    // Pull the class refs and the `provide` tokens out of the
    // mixed array (Nest's `Provider` is a union of class refs and
    // `{ provide, useExisting | useClass | useFactory, ... }`
    // records) and assert each one is present. The names of the
    // class providers are load-bearing because Nest uses them as
    // DI tokens for the classes themselves.
    const providers = adapter.module.providers as Array<unknown>;
    const classProviders = providers.filter((p) => typeof p === 'function');
    expect(classProviders).toEqual([MikroORMJobRepository, MikroORMTransactionManager]);

    const useExistingProviders = providers.filter(
      (p): p is { provide: any; useExisting: any } =>
        typeof p === 'object' &&
        p !== null &&
        'useExisting' in p &&
        !('useClass' in p) &&
        !('useFactory' in p) &&
        !('useValue' in p),
    );
    expect(useExistingProviders).toHaveLength(3);
    expect(useExistingProviders).toContainEqual({
      provide: MikroOrmDriverProvider,
      useExisting: EntityManager,
    });
    expect(useExistingProviders).toContainEqual({
      provide: JOB_REPOSITORY_TOKEN,
      useExisting: MikroORMJobRepository,
    });
    expect(useExistingProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useExisting: MikroORMTransactionManager,
    });
  });

  it('exports exactly 3 tokens: MikroOrmDriverProvider, JOB_REPOSITORY_TOKEN, and TRANSACTION_MANAGER_TOKEN', () => {
    expect(Array.isArray(adapter.module.exports)).toBe(true);
    expect(adapter.module.exports).toHaveLength(3);
    expect(adapter.module.exports).toEqual([
      MikroOrmDriverProvider,
      JOB_REPOSITORY_TOKEN,
      TRANSACTION_MANAGER_TOKEN,
    ]);
  });

  it('exposes a `globalProviders` array of length 3 (the load-bearing host-visible bindings)', () => {
    // `globalProviders` is the *only* way the host app can inject
    // `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` from
    // outside the adapter's module. The `useClass` (not
    // `useExisting`) form is load-bearing: the host does not
    // import the adapter's module, so it needs its own class
    // instance to resolve against. If this length drops to 1 or
    // 0, the host's `moduleRef.get(JOB_REPOSITORY_TOKEN)` calls
    // start throwing at boot.
    expect(Array.isArray(adapter.globalProviders)).toBe(true);
    expect(adapter.globalProviders).toHaveLength(3);

    const globalUseExistingProviders = (adapter.globalProviders as Array<unknown>).filter(
      (p): p is { provide: any; useExisting: any } =>
        typeof p === 'object' &&
        p !== null &&
        'useExisting' in p &&
        !('useClass' in p) &&
        !('useFactory' in p) &&
        !('useValue' in p),
    );
    expect(globalUseExistingProviders).toEqual([
      {
        provide: MikroOrmDriverProvider,
        useExisting: EntityManager,
      },
    ]);

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
      useClass: MikroORMJobRepository,
    });
    expect(useClassProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: MikroORMTransactionManager,
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION NET
  //
  // This is the load-bearing structural invariant for the
  // Task 5 "adapter slimdown" refactor. Before the refactor,
  // `MikroOrmAdapter` accepted a `MikroOrmModuleOptions` argument
  // and called `MikroOrmModule.forRoot(options)` inside its
  // `DynamicModule.imports`, building a connection at adapter
  // boot time. The new adapter is binding-only: the host owns
  // `MikroOrmModule.forRoot(...)` and `MikroOrmAdapter.forRoot()`
  // contributes zero `imports`.
  //
  // If a future change re-introduces the
  // `imports: [MikroOrmModule.forRoot(...)]` shape (or
  // `MikroOrmModule.forRootAsync(...)`, or anything else that
  // builds a `MikroORM` connection inside the adapter), this
  // assertion fails and the regression is caught before it ships.
  // -------------------------------------------------------------------------
  it('does NOT include MikroOrmModule.forRoot in module.imports (structural invariant)', () => {
    // Two assertions, one tripwire:
    //   1. `imports` is `undefined` — the key is absent, not just
    //      empty. (An empty `imports: []` would also fail this.)
    //   2. The property is not present in the object at all —
    //      protects against a future change that switches the
    //      value to `[]` (which would still be a regression even
    //      though it would pass the first assertion).
    expect(adapter.module.imports).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(adapter.module, 'imports')).toBe(false);
  });
});
