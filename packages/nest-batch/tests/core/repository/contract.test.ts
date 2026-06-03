import { describe, expect, test } from 'vitest';
import {
  InMemoryJobRepository,
  RESTARTABLE_DEFAULT_INMEMORY,
} from '../../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../../src/transaction/in-memory-transaction-manager';
import { DeterministicIdGenerator } from '../../../src/repository/id-generator';
import { runJobRepositoryContract } from '../../contracts/job-repository.contract';

// Run the shared contract suite against the in-memory implementation.
// Every `JobRepository` + `TransactionManager` adapter must pass this
// same suite. The in-memory implementation is the canary that proves
// the contract is achievable without a database; the mikro-orm and
// typeorm packages will run the same suite against their own factories.
runJobRepositoryContract(
  {
    create: () => ({
      // DeterministicIdGenerator keeps the per-test state predictable
      // and lets the contract assertions reason about execution ids
      // when needed.
      repo: new InMemoryJobRepository(new DeterministicIdGenerator('id')),
      tx: new InMemoryTransactionManager(),
    }),
  },
  'InMemoryJobRepository + InMemoryTransactionManager',
);

describe('InMemoryJobRepository — non-contract invariants', () => {
  test('RESTARTABLE_DEFAULT_INMEMORY is false (in-memory repo is non-restartable by default)', () => {
    // Captured by the original seed test in this file. The in-memory
    // implementation is non-restartable because its execution contexts
    // are process-local and lost on crash. Real DB-backed adapters
    // (MikroORM, TypeORM) will be restartable and exposed via their
    // own `RESTARTABLE_DEFAULT_*` constants.
    expect(RESTARTABLE_DEFAULT_INMEMORY).toBe(false);
  });
});
