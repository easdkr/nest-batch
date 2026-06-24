/**
 * Kafka connection options accepted by `KafkaAdapter`.
 *
 * KafkaJS is opinionated about client behavior: producers and
 * consumers share the same `Kafka` instance but carry different
 * role-specific configs (e.g. `allowAutoTopicCreation`,
 * `transactionalId`). We keep the shared connection settings here
 * and let the runtime service apply role-specific tuning.
 *
 * The interface is intentionally `Partial<>`-friendly: a host that
 * only needs a local single-node Kafka can pass
 * `{ brokers: ['127.0.0.1:9092'] }` and accept all defaults.
 */
export interface KafkaConnectionOptions {
  /** Kafka broker list (default: `['127.0.0.1:9092']`). */
  brokers?: string[];
  /** Client id prefix (default: `'nest-batch'`). */
  clientId?: string;
  /** SSL configuration. */
  ssl?: boolean | Record<string, unknown>;
  /** SASL authentication. */
  sasl?: unknown;
  /** Connection timeout in ms (default: `3000`). */
  connectionTimeout?: number;
  /** Request timeout in ms (default: `30000`). */
  requestTimeout?: number;
}

/**
 * Resolved Kafka connection settings, with all defaults filled in.
 *
 * `KafkaAdapter.forRoot()` returns a frozen copy of this object
 * under its module-options token; `KafkaRuntime` reads it
 * to build the `Kafka` client instance.
 */
export interface KafkaResolvedConnection {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly ssl: boolean | Record<string, unknown> | undefined;
  readonly sasl: unknown | undefined;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
}

export const KAFKA_DEFAULT_BROKERS = ['127.0.0.1:9092'];
export const KAFKA_DEFAULT_CLIENT_ID = 'nest-batch';
export const KAFKA_DEFAULT_CONNECTION_TIMEOUT = 3000;
export const KAFKA_DEFAULT_REQUEST_TIMEOUT = 30000;

/**
 * Fill in defaults for a `KafkaConnectionOptions` bag and return a
 * frozen, fully-resolved connection descriptor.
 *
 * Splitting this out from the module factory keeps the module file
 * focused on DI plumbing and lets the strategy (and tests) construct
 * a resolved connection without re-implementing the defaults.
 */
export function resolveKafkaConnection(
  options: KafkaConnectionOptions | undefined,
): KafkaResolvedConnection {
  return Object.freeze({
    brokers: options?.brokers ?? KAFKA_DEFAULT_BROKERS,
    clientId: options?.clientId ?? KAFKA_DEFAULT_CLIENT_ID,
    ssl: options?.ssl,
    sasl: options?.sasl,
    connectionTimeout: options?.connectionTimeout ?? KAFKA_DEFAULT_CONNECTION_TIMEOUT,
    requestTimeout: options?.requestTimeout ?? KAFKA_DEFAULT_REQUEST_TIMEOUT,
  });
}
