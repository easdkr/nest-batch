/**
 * `TypeOrmDriverProvider` — the abstract injection token the
 * `@nest-batch/postgresql` (and future `@nest-batch/mysql`) driver
 * sibling packages bind to the concrete `DataSource` for the chosen
 * database.
 *
 * This package (`@nest-batch/typeorm`) is **driver-agnostic**: it
 * does not import `@nestjs/typeorm` (which carries the Postgres
 * driver) or any MySQL-specific `@nestjs/typeorm` companion. Instead,
 * it exports the `TypeOrmDriverProvider` symbol as a `Provider`
 * token; the driver sibling package binds the token to a concrete
 * `DataSource` in its own `forRoot()` factory.
 *
 * The `TypeOrmJobRepository` / `TypeOrmTransactionManager` classes
 * inject the token via the standard `@Inject(TypeOrmDriverProvider)`
 * decorator and cast the resolved value to the host-owned
 * `DataSource` shape. This mirrors the
 * `@nestjs/typeorm` pattern of "host owns the connection, adapter
 * owns the repository".
 */
export const TypeOrmDriverProvider: symbol = Symbol.for(
  '@nest-batch/typeorm/TypeOrmDriverProvider',
);
