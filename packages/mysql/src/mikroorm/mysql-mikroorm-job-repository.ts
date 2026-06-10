// MySQL MikroORM job repository — thin re-export of
// `@nest-batch/mikro-orm`'s `MikroORMJobRepository` + the
// MySQL-flavored `EntityManager` type alias.
//
// The repository logic is driver-agnostic. The slot's
// `MikroORMJobRepository` injects `@Inject(MikroOrmDriverProvider)`
// (a `Symbol.for('@nest-batch/mikro-orm/MikroOrmDriverProvider')`
// token) — the host's `MikroOrmModule.forRoot()` call binds that
// token to a concrete `EntityManager` (MySQL or any other driver),
// and the repository code never sees the driver boundary.
// Re-exporting the class under a MySQL-prefixed name keeps the
// public API symmetrical with the rest of the shell
// (`MysqlMikroOrmTransactionManager` carries the
// `MysqlEntityManager` type as documentation; this class needs
// no such decoration).
import type { EntityManager as MysqlEntityManager } from '@mikro-orm/mysql';

export { MikroORMJobRepository as MysqlMikroOrmJobRepository } from '@nest-batch/mikro-orm';
export type { MysqlEntityManager };
