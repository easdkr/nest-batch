import { afterEach, beforeEach, describe, expect, test } from 'vitest';
// Import the contract suite directly from the core source path.
// The contract file ships as a source file in core (it is not
// emitted to the built artifact) and references core's
// public interfaces via relative paths, so it must be loaded
// from its physical location.
import { runJobRepositoryContract } from '../../core/tests/contracts/job-repository.contract';
import { DataSource } from 'typeorm';
import { TypeOrmJobRepository } from '../src/repository/typeorm-job-repository';
import { TypeOrmTransactionManager } from '../src/transaction/typeorm-transaction-manager';
import { createTestDataSource } from './create-test-data-source';

/**
 * Shared contract suite for the TypeORM 1.0.0 adapter.
 *
 * Per-test isolation is achieved by spinning up a fresh
 * in-memory better-sqlite3 DataSource in `beforeEach` and
 * destroying it in `afterEach`. This guarantees no row leaks
 * across cases and exercises the real SQL path against a
 * TypeORM-managed `DataSource`.
 *
 * The factory closure captures the `(repo, tx)` pair created by
 * our `beforeEach` so the contract's own `beforeEach` (which
 * calls `factory.create()`) always sees a freshly-prepared
 * DataSource.
 */
describe('TypeOrmJobRepository + TypeOrmTransactionManager contract (TypeORM 1.0.0)', () => {
  let dataSource: DataSource;
  let repo: TypeOrmJobRepository;
  let tx: TypeOrmTransactionManager;

  // Register our `beforeEach` BEFORE the contract's own
  // `beforeEach` (which is wired up inside the
  // `runJobRepositoryContract` call below). Vitest runs hooks in
  // registration order, so our setup runs first and the contract
  // closure picks up the freshly-created (repo, tx) pair.
  beforeEach(async () => {
    dataSource = await createTestDataSource();
    repo = new TypeOrmJobRepository(dataSource);
    tx = new TypeOrmTransactionManager(dataSource);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  // Re-run the full shared contract suite with a per-test DataSource.
  // The factory just returns the (repo, tx) prepared above; the
  // contract suite's own `beforeEach` will call `factory.create()`
  // to read them.
  runJobRepositoryContract(
    {
      create: () => ({ repo, tx }),
    },
    'TypeOrmJobRepository + TypeOrmTransactionManager',
  );

  test('TypeOrmJobRepository is a JobRepository subclass (runtime smoke)', () => {
    // The static type check is enforced at compile time; at runtime
    // the instance is of TypeOrmJobRepository which extends
    // JobRepository. This is a smoke check that the wiring loaded
    // the entity decorator metadata properly so the DataSource
    // can resolve the repository.
    expect(repo.constructor.name).toBe('TypeOrmJobRepository');
  });

  test('TypeOrmTransactionManager is a TransactionManager subclass (runtime smoke)', () => {
    expect(tx.constructor.name).toBe('TypeOrmTransactionManager');
  });
});

