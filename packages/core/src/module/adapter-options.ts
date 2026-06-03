/**
 * `AdapterOptions` — the common options bag that sibling adapter
 * packages extend.
 *
 * Sibling packages (e.g. `@nest-batch/mikro-orm`, `@nest-batch/typeorm`,
 * `@nest-batch/bullmq`) extend this interface with their own fields:
 *
 * ```ts
 * // in @nest-batch/mikro-orm
 * export interface MikroOrmAdapterOptions extends AdapterOptions {
 *   contextName?: string;
 *   entities?: EntityClass[];
 * }
 * ```
 *
 * The host app then passes the union into `NestBatchModule.forRoot({ ...
 * <adapterFields> })`. The core module preserves every field in the
 * `MODULE_OPTIONS_TOKEN` provider so the adapter can read it back out
 * via `Inject(MODULE_OPTIONS_TOKEN)`.
 *
 * Why a structural shape (`Record<string, unknown>`) and not a closed
 * interface with no fields?
 *   - Lets adapters extend with their own fields without forcing core
 *     to ship a `Pick<...>` per adapter.
 *   - The runtime check is intentionally permissive: core is
 *     dependency-light and does not know which adapters exist.
 *   - TypeScript users still get end-to-end type safety through
 *     declaration merging / interface extension on the adapter side.
 */
export interface AdapterOptions {
  /**
   * Reserved for forward compatibility. Concrete adapters are
   * encouraged to declare their own extension interface and re-declare
   * this with a more specific type so `useFactory` return values are
   * type-checked end-to-end.
   */
  readonly [key: string]: unknown;
}
