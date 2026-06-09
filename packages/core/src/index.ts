// Public API barrel for @nest-batch/core.
//
// Decorator functions (ItemReader, ItemProcessor, ItemWriter, Tasklet) live in
// ./decorators and share names with interfaces in ./core/item. To avoid name
// collisions in the public surface, decorators are re-exported under the
// `BatchDecorators` namespace; interfaces remain reachable as bare names from
// ./core/item (or via core/index).
export * from './core';
export * from './compiler';
export * from './partition-helpers';
export * from './registry';
export * from './execution';
export * from './transaction';
export * from './repository';
export * as BatchDecorators from './decorators';
export * from './module';
export * from './builder';
export * from './explorer';
export * from './listeners';
export * from './policies';
export * from './flow';
export * from './observability';
export * from './adapters';
