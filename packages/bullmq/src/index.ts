/**
 * Public API barrel for `@nest-batch/bullmq`.
 *
 * The host application should depend exclusively on this barrel:
 *   - `BullmqBatchModule` is the Nest dynamic module;
 *   - `BullMqExecutionStrategy` is the strategy class (also
 *     exported individually so callers can inject it directly for
 *     inspection / health checks);
 *   - `BULLMQ_MODULE_OPTIONS` is the DI token for the resolved
 *     module options bag;
 *   - the connection helpers are re-exported so callers can build
 *     a fully-resolved `BullMqResolvedConnection` from a partial
 *     `BullMqConnectionOptions` without importing the internal
 *     `connection.ts` file.
 *
 * Internal modules (`./bullmq-execution-strategy`,
 * `./bullmq-batch.module`, `./module-options`, `./connection`)
 * are implementation details and may move between releases.
 */
export * from './connection';
export * from './module-options';
export * from './bullmq-execution-strategy';
export * from './bullmq-batch.module';
