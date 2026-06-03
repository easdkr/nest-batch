import { describe, it, expect } from 'vitest';

import * as publicApi from '../../../src/index';

/**
 * Typed bag for iterating over module namespace exports. Using `unknown` (not
 * `any`) keeps this strictly typed; we only inspect identity / defined-ness,
 * never call into the values.
 */
type ExportBag = Record<string, unknown>;

describe('public API of @nest-batch/core', () => {
  it('the package root barrel resolves and exports at least one top-level name', () => {
    const keys = Object.keys(publicApi);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('every top-level export from the package root is defined (no undefined values)', () => {
    const bag = publicApi as unknown as ExportBag;
    const names = Object.keys(bag);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const value = bag[name];
      expect(value, `top-level export "${name}" must be defined (not undefined)`).toBeDefined();
    }
  });

  it('the BatchDecorators namespace is exported and every member is defined', () => {
    const bag = publicApi as unknown as ExportBag;
    const decorators = bag['BatchDecorators'];
    expect(decorators, 'BatchDecorators namespace must be exported from package root').toBeDefined();

    const members = decorators as ExportBag;
    const memberNames = Object.keys(members);
    expect(memberNames.length).toBeGreaterThan(0);

    for (const name of memberNames) {
      const value = members[name];
      expect(value, `BatchDecorators.${name} must be defined (not undefined)`).toBeDefined();
    }
  });

  it('the Task 12 adapter tokens are exported from the package root', () => {
    const bag = publicApi as unknown as ExportBag;
    // Each new token / class / provider record must be reachable as a
    // bare top-level name from `@nest-batch/core` (i.e. through the
    // public barrel), so sibling packages do not have to import from
    // deep relative paths. Note: type-only exports (interfaces,
    // type aliases) are erased at runtime and cannot be checked
    // here; they are validated by `tsc --noEmit` instead.
    for (const name of [
      'JOB_REPOSITORY_TOKEN',
      'TRANSACTION_MANAGER_TOKEN',
      'BATCH_SCHEDULE_REGISTRY',
      'MODULE_OPTIONS_TOKEN',
      'EXECUTION_STRATEGY',
      'BatchScheduleRegistry',
      'DuplicateBatchScheduleError',
      'LEGACY_BATCH_OPTIONS_TOKEN',
      'NestBatchModule',
    ]) {
      expect(bag[name], `top-level export "${name}" must be defined`).toBeDefined();
    }
  });
});
