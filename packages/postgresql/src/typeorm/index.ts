/**
 * Public surface for the `typeorm/` shell directory.
 *
 * Re-exports the `PostgresTypeOrmAdapter` factory and its
 * provider classes so consumers can import them via
 * `@nest-batch/postgresql` (the root barrel pulls this file in)
 * without having to know the internal directory layout.
 *
 * T-AC-2b boundary: this directory lives in
 * `@nest-batch/postgresql`, NOT in `@nest-batch/typeorm`. The
 * slot package stays driver-agnostic; the Postgres-specific `pg`
 * driver binding lives here. The `TypeOrmJobRepository` /
 * `TypeOrmTransactionManager` *shape* is owned by the slot
 * (`@nest-batch/typeorm`); the *implementations*
 * (`PostgresTypeOrmJobRepository` /
 * `PostgresTypeOrmTransactionManager`) are owned here because
 * the Postgres flavor uses Postgres-native SQL
 * (`ON CONFLICT (job_name, job_key) DO NOTHING`, double-quoted
 * identifiers, `NOW()`).
 */
export * from './postgres-typeorm.adapter';
export * from './postgres-typeorm.module';
export * from './postgres-typeorm-job-repository';
export * from './postgres-typeorm-transaction-manager';
