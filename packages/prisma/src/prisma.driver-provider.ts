/**
 * `PrismaDriverProvider` — the abstract injection token the
 * `@nest-batch/postgresql` (and future `@nest-batch/mysql`) driver
 * sibling packages bind to the concrete `PrismaClient` instance for
 * the chosen database.
 *
 * This package (`@nest-batch/prisma`) owns the
 * `PrismaDriverProvider` symbol and repository implementations, but
 * does not ship runnable Prisma schema or migration artifacts. The
 * consuming app includes the documented batch meta models in its own
 * schema, generates its own client, and driver sibling packages bind
 * this token to that `PrismaClient` instance in their own
 * `forRoot()` factories.
 *
 * The `PrismaJobRepository` / `PrismaTransactionManager` classes
 * inject the token via the standard `@Inject(PrismaDriverProvider)`
 * decorator and cast the resolved value to the host-owned
 * `PrismaClient` shape. The repository uses raw SQL via
 * `prisma.$queryRaw` / `prisma.$executeRaw` so it does NOT depend
 * on Prisma's generated client model names.
 */
export const PrismaDriverProvider: symbol = Symbol.for('@nest-batch/prisma/PrismaDriverProvider');
