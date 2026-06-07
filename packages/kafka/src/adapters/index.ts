/**
 * Public surface for the Kafka adapter factory.
 *
 * The `KafkaAdapter` is the only entry point the host should
 * depend on for the new factory-pattern API. The internal module
 * class (`KafkaModule`) is exported alongside it as a NestJS
 * identifier.
 */
export * from './kafka.adapter';
