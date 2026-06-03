import 'reflect-metadata';
import {
  BATCH_ITEM_READER_METADATA,
  BATCH_ITEM_PROCESSOR_METADATA,
  BATCH_ITEM_WRITER_METADATA,
} from './constants';

/**
 * Marks a method as the `ItemReader.read()` handler for a chunk step.
 *
 * Contract:
 *   - Method may return `Promise<T | null>` (null = EOF) OR
 *     `AsyncIterable<T>` for streaming-style readers.
 *   - Exactly one `@ItemReader()` per chunk step.
 *   - Metadata stored on the prototype method under `BATCH_ITEM_READER_METADATA`
 *     so the DefinitionCompiler can resolve it to a `ReaderRef`.
 */
export function ItemReader(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(BATCH_ITEM_READER_METADATA, true, target, propertyKey);
  };
}

/**
 * Marks a method as the `ItemProcessor.process(item)` handler for a chunk step.
 *
 * Contract:
 *   - Receives a single item, returns the (possibly transformed) item.
 *   - Returning `null` or `undefined` filters the item out of the chunk.
 *   - Exactly one `@ItemProcessor()` per chunk step (or none — processor is optional).
 *   - Metadata stored on the prototype method under `BATCH_ITEM_PROCESSOR_METADATA`.
 */
export function ItemProcessor(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(BATCH_ITEM_PROCESSOR_METADATA, true, target, propertyKey);
  };
}

/**
 * Marks a method as the `ItemWriter.write(items)` handler for a chunk step.
 *
 * Contract:
 *   - Receives an array of items for the chunk, returns `Promise<void>`.
 *   - Exactly one `@ItemWriter()` per chunk step.
 *   - Metadata stored on the prototype method under `BATCH_ITEM_WRITER_METADATA`.
 */
export function ItemWriter(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(BATCH_ITEM_WRITER_METADATA, true, target, propertyKey);
  };
}
