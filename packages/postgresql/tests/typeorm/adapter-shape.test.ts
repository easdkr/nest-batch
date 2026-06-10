/**
 * Pure-shape regression suite for `PostgresTypeOrmAdapter`.
 *
 * Mirrors `packages/typeorm/tests/adapter-shape.test.ts` (the
 * slot-package's structural tripwire), but asserts the Postgres
 * shell's *exact* BatchAdapter shape:
 *
 *   - name is 'postgres-typeorm' (NOT 'typeorm', NOT
 *     'mysql-typeorm') — the shell is a Postgres driver binding,
 *     not the slot's adapter.
 *   - the host module class identity is preserved
 *     (`PostgresTypeOrmBatchModule`), NOT the slot's
 *     `TypeOrmBatchModule`. The class lives in
 *     `packages/postgresql/src/typeorm/`, not
 *     `packages/typeorm/src/adapters/`.
 *   - the module is a `global: true` `DynamicModule` literal
 *   - the `imports` key is **absent** (i.e. `undefined`, NOT
 *     `[]`) — the adapter is binding-only and does not bootstrap
 *     a `TypeOrmModule.forRoot()` call (the host owns that
 *     call in its own `AppModule.imports`)
 *   - the provider / export / `globalProviders` arrays have the
 *     exact counts expected (4 / 2 / 2)
 *   - the 2 class providers are the **Postgres shell's** classes
 *     (`PostgresTypeOrmJobRepository`,
 *     `PostgresTypeOrmTransactionManager`), not the slot's
 *     `TypeOrmJobRepository` / `TypeOrmTransactionManager`.
 *     The shell instantiates its own implementations because
 *     the Postgres flavor uses Postgres-native SQL
 *     (`ON CONFLICT (job_name, job_key) DO NOTHING` and
 *     double-quoted identifiers), so the MySQL-flavored
 *     `MysqlTypeOrmJobRepository` body is wrong for Postgres
 *     even though the TypeORM client API is driver-agnostic.
 *
 * No mocking, no DB, no `beforeAll` / `afterAll` — every assertion
 * is a pure synchronous object-shape check. If you find yourself
 * wanting to add one, the test belongs in a contract test that
 * runs against a real Postgres testcontainer, not here.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
} from '@nest-batch/core';

import { PostgresTypeOrmAdapter, PostgresTypeOrmBatchModule } from '../../src/typeorm';
import { PostgresTypeOrmJobRepository } from '../../src/typeorm/postgres-typeorm-job-repository';
import { PostgresTypeOrmTransactionManager } from '../../src/typeorm/postgres-typeorm-transaction-manager';

describe('PostgresTypeOrmAdapter — shape (Wave 2 part 2)', () => {
  // `forRoot()` is a pure factory with no arguments and no side
  // effects. Calling it once at the suite top keeps the shape
  // frozen across every `it` block — if anyone reorders or
  // re-instantiates the call site, the assertions below catch it.
  const adapter = PostgresTypeOrmAdapter.forRoot();

  it('returns a BatchAdapter whose name is "postgres-typeorm"', () => {
    // The name is load-bearing: the factory pattern in
    // `NestBatchModule.forRoot({ adapters: { persistence, ... } })`
    // keys on this string to identify the dialect + ORM. A
    // regression to "typeorm" would silently route the host
    // through the driver-agnostic slot adapter (no Postgres
    // binding), and a regression to "mysql-typeorm" would wire
    // the wrong dialect entirely. Pin the exact string.
    expect(adapter.name).toBe('postgres-typeorm');
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

  it('preserves the host class identity: module.module === PostgresTypeOrmBatchModule', () => {
    // The empty `PostgresTypeOrmBatchModule` class is the
    // module's host identifier. If a refactor swaps it for
    // the slot's `TypeOrmBatchModule` (from
    // `packages/typeorm/src/adapters/`), the DI graph silently
    // re-roots and the host app starts seeing the wrong
    // provider scope. The shell is a Postgres sibling of
    // the slot, not a child of it; the class must live here
    // and only here.
    expect(adapter.module.module).toBe(PostgresTypeOrmBatchModule);
  });

  it('omits the `imports` key entirely (undefined — not [])', () => {
    // The adapter is binding-only. It must NOT carry an `imports`
    // array (even an empty one) on its `DynamicModule`, because
    // an empty `imports: []` would still be picked up by Nest's
    // module-merge code path and any future addition would
    // silently re-introduce the TypeOrmModule.forRoot coupling
    // this refactor removed. The invariant is `undefined`, not
    // `[]`.
    expect(adapter.module.imports).toBeUndefined();
  });

  it('is registered as a global module (module.global === true)', () => {
    // The host's `TypeOrmModule.forRoot()` is the source of the
    // `DataSource` / `EntityManager` injections. For those tokens
    // to be visible inside this adapter's module, the adapter's
    // module must be `global: true` — otherwise Nest's module
    // encapsulation hides them.
    expect(adapter.module.global).toBe(true);
  });

  it('declares exactly 4 providers: the two Postgres classes plus the two useExisting token bindings', () => {
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
      PostgresTypeOrmJobRepository,
      PostgresTypeOrmTransactionManager,
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
      useExisting: PostgresTypeOrmJobRepository,
    });
    expect(useExistingProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useExisting: PostgresTypeOrmTransactionManager,
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
      useClass: PostgresTypeOrmJobRepository,
    });
    expect(useClassProviders).toContainEqual({
      provide: TRANSACTION_MANAGER_TOKEN,
      useClass: PostgresTypeOrmTransactionManager,
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION NET
  //
  // The load-bearing structural invariant for the Wave 2 shell
  // port. The shape test on the slot
  // (`packages/typeorm/tests/adapter-shape.test.ts`) is the
  // tripwire that caught the "adapter slimdown" refactor in
  // Task 3; this file is the mirror tripwire for the Postgres
  // shell. If a future change re-introduces the
  // `imports: [TypeOrmModule.forRoot(...)]` shape (or
  // `TypeOrmModule.forRootAsync(...)`, or anything else that
  // builds a `DataSource` inside the shell), this assertion
  // fails and the regression is caught before it ships.
  //
  // It also fails if the shell silently re-uses the slot's
  // `TypeOrmBatchModule` (the `module.module` assertion above)
  // or its `TypeOrmJobRepository` (the provider assertions
  // above) — both are dialect-specific shapes that must NOT
  // cross the T-AC-2b boundary.
  // -------------------------------------------------------------------------
  it('does NOT include TypeOrmModule.forRoot in module.imports (structural invariant)', () => {
    // Two assertions, one tripwire:
    //   1. `imports` is `undefined` — the key is absent, not just
    //      empty. (An empty `imports: []` would also fail this.)
    //   2. The property is not present in the object at all —
    //      protects against a future change that switches the
    //      value to `[]` (which would still be a regression even
    //      though it would pass the first assertion).
    expect(adapter.module.imports).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(adapter.module, 'imports')).toBe(
      false,
    );
  });
});
