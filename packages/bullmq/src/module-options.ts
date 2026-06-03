import type { BullMqConnectionOptions, BullMqResolvedConnection } from './connection';

/**
 * Public options bag for `BullmqBatchModule.forRoot()` and
 * `forRootAsync()`.
 *
 * The fields cover the connections the package needs to wire up:
 *   - `connection`   — the BullMQ `Queue` / `Worker` / `QueueEvents`
 *     share. T17 stores it under `BULLMQ_MODULE_OPTIONS`; T18 splits
 *     the role-specific tuning (worker `maxRetriesPerRequest: null`
 *     + `enableReadyCheck: false`; producer `enableOfflineQueue:
 *     false`) onto this same connection record and derives the
 *     per-role client from it.
 *   - `autoStartWorker` — whether the module should also start a
 *     BullMQ `Worker` on `onApplicationBootstrap`. Defaults to
 *     `false` so a launcher-only deployment does not accidentally
 *     consume Redis. T18 wires the actual worker construction.
 *
 * The interface extends `BullMqConnectionOptions` via composition
 * (not `extends`) so the field can be `undefined` at the top level
 * (the module applies its own defaults via `resolveBullMqConnection`)
 * and the resolved form (with defaults filled in) is what gets
 * handed to the strategy.
 */
export interface BullMqModuleOptions {
  /**
   * Redis connection settings shared by the BullMQ `Queue`,
   * `Worker`, and `QueueEvents` clients this package builds.
   * Optional — defaults are filled in by
   * `resolveBullMqConnection()`.
   */
  connection?: BullMqConnectionOptions;

  /**
   * Whether the module should also spin up a BullMQ `Worker` on
   * `OnApplicationBootstrap`. Default: `false` (launcher-only).
   * Reserved for T18 — the skeleton in T17 does not implement
   * worker lifecycle.
   */
  autoStartWorker?: boolean;

  /**
   * Reserved for future per-adapter extension. Adapter packages
   * (e.g. a future `@nest-batch/mikro-orm` companion) can read
   * the full options bag through this field for cross-cutting
   * config.
   */
  readonly [key: string]: unknown;
}

/**
 * Token under which the resolved module options are registered.
 *
 * The strategy injects the options via this token so it can build
 * the per-role BullMQ connection clients. The token is a
 * package-scoped `Symbol.for` key (mirroring
 * `@nest-batch/core/MODULE_OPTIONS_TOKEN`) so it is unique across
 * the host process even if multiple `@nest-batch/bullmq` versions
 * are loaded.
 */
export const BULLMQ_MODULE_OPTIONS: symbol = Symbol.for(
  '@nest-batch/bullmq/MODULE_OPTIONS',
);

/**
 * Type alias for the fully-resolved options bag. Used by
 * `BullmqBatchModule.forRoot()` to freeze the resolved value under
 * `BULLMQ_MODULE_OPTIONS` and by the strategy to type its injected
 * dependency.
 */
export interface ResolvedBullMqModuleOptions {
  readonly connection: BullMqResolvedConnection;
  readonly autoStartWorker: boolean;
}
