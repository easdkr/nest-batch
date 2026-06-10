// Pure-shape regression suite for `PostgresMikroOrmAdapter`.
//
// These tests pin the *structural* invariants of the adapter — the
// exact shape of the `BatchAdapter` value
// `PostgresMikroOrmAdapter.forRoot()` returns — without booting a
// `TestingModule`, opening a `MikroORM` connection, or instantiating
// any of the provider classes.
//
// Why shape-only (and not the contract suite)?
//   The shared `runJobRepositoryContract` suite (in
//   `packages/core/tests/contracts/`) is the source of truth for
//   *behavioral* invariants — `JobRepository` + `TransactionManager`
//   semantics against a real database. This file is the source of
//   truth for *structural* invariants:
//
//     - the adapter is named `'postgres-mikro-orm'`
//     - the host module class identity is preserved
//       (`PostgresMikroOrmBatchModule`)
//     - the module is a `global: true` `DynamicModule` literal
//     - the `imports` key is **absent** (i.e. `undefined`, NOT
//       `[]`) — the adapter is binding-only and does not bootstrap
//       a `MikroOrmModule.forRoot()` call
//     - the provider / export / `globalProviders` arrays have the
//       exact counts expected (4 / 2 / 2)
//
//   A regression on any of these would slip past the contract
//   suite (which compiles the module and exercises behavior) and
//   quietly break the host's wiring. This file is the tripwire.
//
// No mocking, no DB, no `beforeAll` / `afterAll` — every assertion
// is a pure synchronous object-shape check. If you find yourself
// wanting to add one, the test belongs in the contract suite, not
// here.
import { describe, expect, it } from 'vitest';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '@nest-batch/core';

import { PostgresMikroOrmAdapter } from '../../src/mikroorm/postgres-mikroorm.adapter';
import { PostgresMikroOrmBatchModule } from '../../src/mikroorm/postgres-mikroorm.module';
import { PostgresMikroOrmJobRepository } from '../../src/mikroorm/postgres-mikroorm-job-repository';
import { PostgresMikroOrmTransactionManager } from '../../src/mikroorm/postgres-mikroorm-transaction-manager';

describe('PostgresMikroOrmAdapter — shape (Wave 2 / Task 6)', () => {
  // `forRoot()` is a pure factory with no arguments and no side
  // effects. Calling it once at the suite top keeps the shape
  // frozen across every `it` block — if anyone reorders or
  // re-instantiates the call site, the assertions below catch it.
  const adapter = PostgresMikroOrmAdapter.forRoot();

  it('returns a BatchAdapter whose name is "postgres-mikro-orm"', () => {
    expect(adapter.name).toBe('postgres-mikro-orm');
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

  it('preserves the host class identity: module.module === PostgresMikroOrmBatchModule', () => {
    // The empty `PostgresMikroOrmBatchModule` class is the
    // module's host identifier. If a refactor swaps it for an
    // anonymous class or for the `MikroOrmModule` class from
    // `@mikro-orm/nestjs`, the DI graph silently re-roots and
    // the host app starts seeing the wrong provider scope. Pin
    // the class identity here.
    expect(adapter.module.module).toBe(PostgresMikroOrmBatchModule);
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

  it('declares exactly 4 providers: the two classes plus the two useExisting token bindings', () => {
    expect(Array.isArray(adapter.module.providers)).toBe(true);
    expect(adapter.module.providers).toHaveLength(4);

    // Pull the class refs and the `provide` tokens out of the
    // mixed array (Nest's `Provider` is a union of class refs and
    // `{ provide, useExisting | useClass | useFactory, ... }`
    // records) and assert each one is present. The names of the
    // class providers are load-bearing because Nest uses them as
    // DI tokens for the classes themselves.
    const providers = adapter.module.providers as Array<unknown>;
    const classProviders = providers.filter(
      (p) => typeof p === 'function',
    );
    expect(classProviders).toEqual([
      PostgresMikroOrmJobRepository,
      PostgresMikroOrmTransactionManager,
    ]);

    const useExistingProviders = providers.filter(
      (p): p is { provide: unknown; useExisting: unknown } =>
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
      useExisting: PostgresMikroOrmJobRepository,
    });
    expect(useExistingProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useExisting: PostgresMikroOrmTransactionManager,
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

  it('exposes a `globalProviders` array of length 2 (the load-bearing host-visible bindings)', () => {
    // `globalProviders` is the *only* way the host app can inject
    // `JOB_REPOSITORY_TOKEN` / `TRANSACTION_MANAGER_TOKEN` from
    // outside the adapter's module. The `useClass` (not
    // `useExisting`) form is load-bearing: the host does not
    // import the adapter's module, so it needs its own class
    // instance to resolve against. If this length drops to 1 or
    // 0, the host's `moduleRef.get(JOB_REPOSITORY_TOKEN)` calls
    // start throwing at boot.
    expect(Array.isArray(adapter.globalProviders)).toBe(true);
    expect(adapter.globalProviders).toHaveLength(2);

    const useClassProviders = (adapter.globalProviders as Array<unknown>).filter(
      (p): p is { provide: unknown; useClass: unknown } =>
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
      useClass: PostgresMikroOrmJobRepository,
    });
    expect(useClassProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: PostgresMikroOrmTransactionManager,
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION NET
  //
  // Structural invariant: the adapter must remain binding-only and
  // must not re-introduce `imports: [MikroOrmModule.forRoot(...)]`
  // (or any other construction of a `MikroORM` connection inside
  // the adapter). The host owns the connection; the shell only
  // declares the provider / export surface.
  //
  // If a future change adds `imports` (even an empty `[]`), this
  // assertion fails and the regression is caught before it ships.
  // -------------------------------------------------------------------------
  it('does NOT include MikroOrmModule.forRoot in module.imports (structural invariant)', () => {
    expect(adapter.module.imports).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(adapter.module, 'imports')).toBe(
      false,
    );
  });
});
