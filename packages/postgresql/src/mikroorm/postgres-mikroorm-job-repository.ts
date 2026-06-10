// Postgres MikroORM job repository — thin re-export of
// `@nest-batch/mikro-orm`'s `MikroORMJobRepository`.
//
// The repository logic is driver-agnostic. The slot's
// `MikroORMJobRepository` injects `@Inject(MikroOrmDriverProvider)`
// (a `Symbol.for('@nest-batch/mikro-orm/MikroOrmDriverProvider')`
// token) — the host's `MikroOrmModule.forRoot()` call binds that
// token to a concrete `EntityManager` (Postgres, MySQL, or any
// other driver), and the repository code never sees the driver
// boundary. Re-exporting the class under a Postgres-prefixed name
// keeps the public API symmetrical with the rest of the shell
// (`PostgresMikroOrmTransactionManager` carries the
// `PostgresEntityManager` type as documentation; this class needs
// no such decoration).
export { MikroORMJobRepository as PostgresMikroOrmJobRepository } from '@nest-batch/mikro-orm';
