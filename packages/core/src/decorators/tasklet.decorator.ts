import 'reflect-metadata';
import { BATCH_TASKLET_METADATA } from './constants';

/**
 * Method decorator that marks a `@Stepable` method as a tasklet handler
 * (single execution, not a chunk loop).
 */
export function Tasklet(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(BATCH_TASKLET_METADATA, true, descriptor.value as object);
    // Also stash on the prototype method so explorer can read both
    Reflect.defineMetadata(BATCH_TASKLET_METADATA, true, target, propertyKey);
  };
}
