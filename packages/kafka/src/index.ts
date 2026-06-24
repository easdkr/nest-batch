/**
 * Public API barrel for `@nest-batch/kafka`.
 *
 * The host application should depend exclusively on this barrel:
 *   - `KafkaAdapter` is the new factory-pattern transport
 *     adapter (use with `NestBatchModule.forRoot({ adapters:
 *     { transport: KafkaAdapter.forRoot(...) } })`).
 *   - `KafkaExecutionStrategy` is the strategy class.
 *   - `KAFKA_MODULE_OPTIONS` is the DI token for the resolved
 *     module options bag.
 *   - the connection helpers are re-exported so callers can build
 *     a fully-resolved `KafkaResolvedConnection` from a partial
 *     `KafkaConnectionOptions`.
 */
export * from './connection';
export * from './module-options';
export * from './kafka-runtime';
export * from './kafka-execution-strategy';
export * from './kafka-schedule';
export * from './adapters';
