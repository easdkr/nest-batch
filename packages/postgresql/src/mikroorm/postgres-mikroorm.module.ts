import { Module } from '@nestjs/common';

/**
 * `PostgresMikroOrmBatchModule` — empty Nest module class that owns
 * the MikroORM-Postgres batch adapter providers.
 *
 * The class has no body on purpose: it is purely a `DynamicModule`
 * carrier. Nest's module system requires *some* class to identify
 * the module — the empty class is the minimum possible surface.
 */
@Module({})
export class PostgresMikroOrmBatchModule {}
