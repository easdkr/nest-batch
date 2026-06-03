/**
 * Public surface for the `module/` package directory.
 *
 * Exports the `NestBatchModule` (the dynamic Nest module), the
 * `BatchScheduleRegistry` provider, the canonical injection tokens,
 * and the `AdapterOptions` interface sibling packages extend.
 */
export * from './tokens';
export * from './adapter-options';
export * from './batch-schedule-registry';
export * from './nest-batch.module';
