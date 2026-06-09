/**
 * `PrismaDriverProvider` — the abstract injection token the
 * `@nest-batch/postgresql` (and future `@nest-batch/mysql`) driver
 * sibling packages bind to the concrete `PrismaClient` instance for
 * the chosen database.
 *
 * This package (`@nest-batch/prisma`) is **driver-agnostic**: it
 * does not import `prisma` (the Prisma CLI) or declare a
 * `provider = "postgresql"` / `provider = "mysql"` schema in its
 * `prisma/schema.prisma`. Instead, it exports the
 * `PrismaDriverProvider` symbol as a `Provider` token; the driver
 * sibling package binds the token to a concrete `PrismaClient`
 * instance in its own `forRoot()` factory.
 *
 * The `PrismaJobRepository` / `PrismaTransactionManager` classes
 * inject the token via the standard `@Inject(PrismaDriverProvider)`
 * decorator and cast the resolved value to the host-owned
 * `PrismaClient` shape. The repository uses raw SQL via
 * `prisma.$queryRaw` / `prisma.$executeRaw` so it does NOT depend
 * on Prisma's generated client model names (those are owned by the
 * driver sibling's bundled `prisma/schema.prisma`).
 *
 * The bundled `prisma/schema.prisma` (Postgres provider) has moved
 * to `@nest-batch/postgresql/prisma/schema.prisma`. The
 * `@nest-batch/mysql` sibling ships its own `prisma/schema.prisma`
 * with the `mysql` provider.
 */
export const PrismaDriverProvider: symbol = Symbol.for(
  '@nest-batch/prisma/PrismaDriverProvider',
);
