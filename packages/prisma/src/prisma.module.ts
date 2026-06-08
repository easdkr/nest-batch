import { Module } from '@nestjs/common';

/**
 * Empty Nest module class that owns the Prisma batch adapter
 * providers.
 *
 * The class has no body on purpose: it is purely a `DynamicModule`
 * carrier for the `forRoot()` factory below. Nest's module system
 * requires *some* class to identify the module.
 */
@Module({})
export class PrismaBatchModule {}
