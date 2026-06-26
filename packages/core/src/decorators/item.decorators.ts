import { SetMetadata } from '@nestjs/common';
import {
  BATCH_ITEM_READER_METADATA,
  BATCH_ITEM_PROCESSOR_METADATA,
  BATCH_ITEM_WRITER_METADATA,
} from './constants';

export interface ItemReaderOptions {
  factory?: boolean;
}

export interface ItemReaderMetadata {
  kind: 'reader';
  factory: boolean;
}

export interface ItemProcessorMetadata {
  kind: 'processor';
}

export interface ItemWriterMetadata {
  kind: 'writer';
}

/**
 * Marks a method as the `ItemReader.read()` handler for a chunk step.
 *
 * Contract:
 *   - Default mode: method is called for every read and may return
 *     `Promise<T | null>` (null = EOF).
 *   - Factory mode (`{ factory: true }`): method is called once at step
 *     start and must return an `ItemReader`, optionally with `ItemStream`.
 *   - Exactly one `@ItemReader()` per chunk step.
 */
export function ItemReader(options: ItemReaderOptions = {}): MethodDecorator {
  return SetMetadata(BATCH_ITEM_READER_METADATA, {
    kind: 'reader',
    factory: options.factory === true,
  } satisfies ItemReaderMetadata);
}

/**
 * Marks a method as the `ItemProcessor.process(item)` handler for a chunk step.
 *
 * Contract:
 *   - Receives a single item, returns the (possibly transformed) item.
 *   - Returning `null` or `undefined` filters the item out of the chunk.
 *   - Exactly one `@ItemProcessor()` per chunk step (or none — processor is optional).
 */
export function ItemProcessor(): MethodDecorator {
  return SetMetadata(BATCH_ITEM_PROCESSOR_METADATA, {
    kind: 'processor',
  } satisfies ItemProcessorMetadata);
}

/**
 * Marks a method as the `ItemWriter.write(items)` handler for a chunk step.
 *
 * Contract:
 *   - Receives an array of items for the chunk, returns `Promise<void>`.
 *   - Exactly one `@ItemWriter()` per chunk step.
 */
export function ItemWriter(): MethodDecorator {
  return SetMetadata(BATCH_ITEM_WRITER_METADATA, {
    kind: 'writer',
  } satisfies ItemWriterMetadata);
}
