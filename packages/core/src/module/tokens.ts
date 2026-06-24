/**
 * Public injection tokens for the `@nest-batch/core` module surface.
 *
 * These tokens are the stable, package-scoped identifiers sibling packages
 * (e.g. `@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/bullmq`)
 * use to bind their own providers into the core DI graph. They are
 * registered in the global `Symbol.for` registry under stable, package-
 * scoped keys so they are unique across the host process even if the
 * package is loaded multiple times.
 *
 * Why symbols and not string tokens?
 *   - Symbols cannot collide with a user string by accident.
 *   - `Symbol.for(key)` gives us cross-realm uniqueness without the
 *     caller having to thread the token through `import` chains — a
 *     host can resolve any of these tokens by reaching into
 *     `Symbol.for('...description...')` and getting the same value.
 *   - Symbols are erased from emitted JavaScript, so they do not
 *     pollute production bundles with debug strings.
 *
 * Why a stable description (not `Symbol(description)`)?
 *   - `Symbol.for('k')` only works if the *same* string is passed both
 *     times. Hard-coding a `description` lets future sibling packages
 *     resolve the token without importing this file (useful for tooling
 *     and for ad-hoc cross-package debugging).
 */
import { EXECUTION_STRATEGY } from '../execution/execution-strategy';

/**
 * Injection token for the `JobRepository` implementation.
 *
 * Adapter packages (`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, ...)
 * bind their `JobRepository` subclass to this token. By default the host
 * app is expected to register its own `JobRepository` provider — core
 * does NOT ship a default binding because the choice of persistence
 * backend is the host's decision.
 */
export const JOB_REPOSITORY_TOKEN: symbol = Symbol.for('@nest-batch/core/JOB_REPOSITORY');

/**
 * Injection token for the `TransactionManager` implementation.
 *
 * Adapter packages bind their transaction manager to this token. The
 * `JobRepository` implementation is expected to participate in the same
 * transaction (e.g. share the same `EntityManager` / `DataSource`).
 */
export const TRANSACTION_MANAGER_TOKEN: symbol = Symbol.for('@nest-batch/core/TRANSACTION_MANAGER');

/**
 * Injection token for the `BatchScheduleRegistry` provider.
 *
 * The `BatchExplorer` populates this registry with `@BatchScheduled`
 * metadata it discovers on `@Jobable` classes. Scheduler adapters read
 * from this registry to install the actual timers or external schedules.
 * Keeping the registry as a stable token means adapters can inject it
 * (for introspection / health checks) without depending on the explorer's
 * internal state.
 */
export const BATCH_SCHEDULE_REGISTRY: symbol = Symbol.for(
  '@nest-batch/core/BATCH_SCHEDULE_REGISTRY',
);

/**
 * Injection token for the module's resolved options bag.
 *
 * Backs the post-`useFactory` options read (T2 will wire the async
 * factory provider to write into this slot). Sibling packages and the
 * host app can read the resolved options by injecting this token. The
 * shape is the union of `NestBatchModuleOptions` plus whatever an
 * adapter's own config contributed, so the value is a
 * `Record<string, unknown>` at runtime.
 *
 * The previous `'BATCH_OPTIONS'` string alias was removed in the
 * T1 type-contract refactor — hosts that need the options bag should
 * inject `MODULE_OPTIONS_TOKEN` instead.
 */
export const MODULE_OPTIONS_TOKEN: symbol = Symbol.for('@nest-batch/core/MODULE_OPTIONS');

/**
 * Polymorphic execution strategy token.
 *
 * Re-exported here from `execution/execution-strategy.ts` so that the
 * module surface is the single import path for downstream packages.
 * Apps that want the default in-process strategy wire up
 * `IN_PROCESS_EXECUTION_STRATEGY_PROVIDER`; sibling packages (e.g.
 * `@nest-batch/bullmq`) provide a custom binding under this same
 * token.
 */
export { EXECUTION_STRATEGY };
