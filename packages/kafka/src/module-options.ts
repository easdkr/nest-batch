import type { KafkaConnectionOptions, KafkaResolvedConnection } from './connection';

/**
 * Public options bag for `KafkaAdapter.forRoot()` and `forRootAsync()`.
 *
 * The fields cover the connections the package needs to wire up:
 *   - `connection`   — the Kafka `producer` / `consumer` share.
 *     T stores it under `KAFKA_MODULE_OPTIONS`; the runtime service
 *     splits the role-specific tuning onto this same connection
 *     record and derives the per-role client from it.
 *   - `autoStartConsumer` — whether the module should also start a
 *     Kafka `consumer` on `onApplicationBootstrap`. Defaults to
 *     `false` so a launcher-only deployment does not accidentally
 *     consume messages.
 *   - `consumerGroupId` — the consumer group id. Defaults to
 *     `'nest-batch-consumer'`.
 *   - `topic` — the Kafka topic name. Defaults to
 *     `'nest-batch-work'`.
 */
export interface KafkaModuleOptions {
  /**
   * Kafka connection settings shared by the producer and consumer
   * clients this package builds. Optional — defaults are filled in
   * by `resolveKafkaConnection()`.
   */
  connection?: KafkaConnectionOptions;

  /**
   * Whether the module should also spin up a Kafka `consumer` on
   * `OnApplicationBootstrap`. Default: `false` (launcher-only).
   */
  autoStartConsumer?: boolean;

  /**
   * Consumer group id. Default: `'nest-batch-consumer'`.
   */
  consumerGroupId?: string;

  /**
   * Kafka topic name. Default: `'nest-batch-work'`.
   */
  topic?: string;

  /**
   * Reserved for future per-adapter extension.
   */
  readonly [key: string]: unknown;
}

/**
 * Token under which the resolved module options are registered.
 *
 * The strategy injects the options via this token so it can build
 * the Kafka client. The token is a package-scoped `Symbol.for` key
 * so it is unique across the host process.
 */
export const KAFKA_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/kafka/MODULE_OPTIONS',
);

/**
 * Type alias for the fully-resolved options bag.
 */
export interface ResolvedKafkaModuleOptions {
  readonly connection: KafkaResolvedConnection;
  readonly autoStartConsumer: boolean;
  readonly consumerGroupId: string;
  readonly topic: string;
}
