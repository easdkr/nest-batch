/**
 * Public surface for the `adapters/` package directory.
 *
 * Re-exports the `MikroOrmAdapter` factory so consumers can
 * `import { MikroOrmAdapter } from '@nest-batch/mikro-orm'` (or
 * reach the adapter directory directly via
 * `@nest-batch/mikro-orm/adapters`) without coupling to the
 * internal file layout.
 *
 * Mirrors the pattern used by `@nest-batch/core`'s own
 * `core/src/adapters/index.ts` barrel, which re-exports the
 * `InProcessAdapter` factory.
 */
export * from './mikro-orm.adapter';
