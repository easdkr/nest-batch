/**
 * Public surface for the `module/` package directory.
 *
 * Exports the `NestBatchModule` (the dynamic Nest module), the
 * `BatchScheduleRegistry` provider, the canonical injection tokens,
 * and the `BatchAdapter` / `BatchAdaptersConfig` types sibling
 * packages implement to plug into core.
 */
export * from './tokens';
export * from './adapter-options';
export * from './adapter';
export * from './batch-schedule-registry';
export * from './nest-batch.module';
