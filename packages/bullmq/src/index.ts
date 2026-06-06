/**
 * Public API barrel for `@nest-batch/bullmq`.
 *
 * The host application should depend exclusively on this barrel:
 *   - `BullmqAdapter` is the new factory-pattern transport
 *     adapter (use with `NestBatchModule.forRoot({ adapters:
 *     { transport: BullmqAdapter.forRoot(...) } })`).
 *   - `BullMqExecutionStrategy` is the strategy class (also
 *     exported individually so callers can inject it directly for
 *     inspection / health checks).
 *   - `BULLMQ_MODULE_OPTIONS` is the DI token for the resolved
 *     module options bag.
 *   - the connection helpers are re-exported so callers can build
 *     a fully-resolved `BullMqResolvedConnection` from a partial
 *     `BullMqConnectionOptions` without importing the internal
 *     `connection.ts` file.
 *
 * The legacy `BullmqBatchModule` (with `forRoot` / `forRootAsync`
 * static methods) has been replaced by `BullmqAdapter`. Internal
 * modules (`./bullmq-execution-strategy`, `./module-options`,
 * `./connection`, `./adapters/bullmq.module`) are implementation
 * details and may move between releases.
 */
export * from './connection';
export * from './module-options';
export * from './bullmq-execution-strategy';
export * from './bullmq-schedule.service';
export * from './adapters';
