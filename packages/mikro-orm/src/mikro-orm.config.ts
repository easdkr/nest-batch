import { defineConfig, type Options } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { BATCH_META_ENTITIES } from './entities/job-meta.entities';

/**
 * Build a MikroORM config that owns the batch meta-schema
 * (`BATCH_META_ENTITIES` plus user-domain entities) and points the
 * migrator at this package's `src/migrations` directory.
 *
 * Apps that want to run `mikro-orm migration:create` /
 * `migration:up` against the batch meta-schema from outside the
 * package can do:
 *
 *   import { createBatchMikroOrmConfig } from '@nest-batch/mikro-orm';
 *   import { ProductEntity } from './entities/product.entity';
 *
 *   export default createBatchMikroOrmConfig({
 *     entities: [ProductEntity],
 *     dbName: 'my_app',
 *     // ...other MikroORM options
 *   });
 *
 * Then run `pnpm mikro-orm migration:create` from the package or
 * the host — MikroORM picks up the same config either way.
 */
export function createBatchMikroOrmConfig(
  options: Omit<Options, 'entities' | 'extensions' | 'migrations'> & {
    entities?: Options['entities'];
  },
): Options {
  return defineConfig({
    ...options,
    entities: [...(options.entities ?? []), ...BATCH_META_ENTITIES],
    extensions: [Migrator],
    migrations: {
      // The package's owned migrations. Hosts that need to extend
      // the migrator with their own pre/post-batch migrations can
      // import the `001-005` classes directly and append them.
      path: './src/migrations',
      pathTs: './src/migrations',
    },
  });
}
