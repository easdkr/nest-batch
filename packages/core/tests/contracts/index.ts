/**
 * Shared contract test suites for `@nest-batch/core` adapter packages.
 *
 * These suites are intentionally ORM-agnostic: they reference only the
 * public core interfaces (`IJobRepository`, `TransactionManager`) and
 * value types. Each suite is exposed as a function that takes a factory
 * returning a fresh `(repo, tx)` pair per test.
 *
 * Usage from a future adapter package (e.g. `@nest-batch/mikro-orm`):
 *
 *   import { runJobRepositoryContract } from '@nest-batch/core/test-contracts';
 *   import { MikroORMJobRepository } from '../mikroorm-job-repository';
 *   import { MikroORMTransactionManager } from '../mikroorm-transaction-manager';
 *
 *   runJobRepositoryContract(
 *     {
 *       create: () => ({
 *         repo: new MikroORMJobRepository(em),
 *         tx: new MikroORMTransactionManager(em),
 *       }),
 *     },
 *     'MikroORM',
 *   );
 */
export {
  runJobRepositoryContract,
  type JobRepositoryContractFactory,
} from './job-repository.contract';
