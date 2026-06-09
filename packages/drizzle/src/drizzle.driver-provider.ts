/**
 * `DrizzleDriverProvider` — the abstract injection token the
 * `@nest-batch/postgresql` (and future `@nest-batch/mysql`) driver
 * sibling packages bind to the concrete Drizzle `Database` instance
 * for the chosen database.
 *
 * This package (`@nest-batch/drizzle`) is **driver-agnostic**: it
 * does not import `drizzle-orm/pg-core` (Postgres), `drizzle-orm/mysql-core`
 * (MySQL), or `drizzle-orm/node-postgres` / `drizzle-orm/mysql2` (the
 * node drivers). Instead, it exports the `DrizzleDriverProvider`
 * symbol as a `Provider` token; the driver sibling package binds
 * the token to a concrete Drizzle `Database` instance in its own
 * `forRoot()` factory.
 *
 * The `DrizzleJobRepository` / `DrizzleTransactionManager` classes
 * inject the token via the standard `@Inject(DrizzleDriverProvider)`
 * decorator and cast the resolved value to the host-owned
 * `Database` shape. The repository uses `drizzle-orm`'s
 * driver-agnostic `sql` template tag (from `drizzle-orm`, NOT from
 * `drizzle-orm/pg-core` or `drizzle-orm/mysql-core`) for raw SQL.
 */
export const DrizzleDriverProvider: symbol = Symbol.for(
  '@nest-batch/drizzle/DrizzleDriverProvider',
);
