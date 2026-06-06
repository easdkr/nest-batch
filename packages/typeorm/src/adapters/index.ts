/**
 * Public surface for the `adapters/` package directory.
 *
 * Re-exports the `TypeOrmAdapter` factory so consumers can
 * import it via `@nest-batch/typeorm` (the root barrel pulls
 * this file in) without having to know the internal directory
 * layout.
 *
 * The factory is the recommended entry point for wiring
 * TypeORM 1.0.0 as the `@nest-batch/core` persistence backend.
 * The legacy `NestBatchTypeOrmModule` (mentioned in
 * `packages/typeorm/README.md`) was never actually implemented
 * in code; this adapter is the canonical replacement and the
 * shape that lines up with the new factory-pattern API
 * (`NestBatchModule.forRoot({ adapters: { persistence, ... } })`).
 */
export * from './typeorm.adapter';
