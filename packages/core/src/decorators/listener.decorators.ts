import 'reflect-metadata';
import { BATCH_LISTENER_METADATA } from './constants';
import type { ListenerKind, ListenerPhase } from '../core/ir/listener-definition';

/**
 * Stored under `BATCH_LISTENER_METADATA` for each listener method.
 * Mirrors `ListenerDefinition` minus the resolved `ref` (which the
 * DefinitionCompiler fills in by walking the class).
 *
 * The `skip` kind is special: it has no before/after/on-error phase,
 * it is a single fire-and-forget callback per skip event. We record
 * `phase: 'after'` as a placeholder so the metadata shape stays uniform;
 * the skip dispatch table is built in Task 25.
 */
export interface ListenerOptions {
  kind: ListenerKind;
  phase: ListenerPhase;
  nonCritical?: boolean;
}

function defineListener(
  target: object,
  propertyKey: string | symbol,
  options: ListenerOptions,
): void {
  Reflect.defineMetadata(BATCH_LISTENER_METADATA, options, target, propertyKey);
}

function listenerDecorator(options: ListenerOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    defineListener(target, propertyKey, options);
  };
}

// ---------------------------------------------------------------------------
// Job-level listeners (2)
// ---------------------------------------------------------------------------

/** Fires before a job execution starts. */
export const BeforeJob = (): MethodDecorator =>
  listenerDecorator({ kind: 'job', phase: 'before' });

/** Fires after a job execution finishes (regardless of status). */
export const AfterJob = (): MethodDecorator =>
  listenerDecorator({ kind: 'job', phase: 'after' });

// ---------------------------------------------------------------------------
// Step-level listeners (2)
// ---------------------------------------------------------------------------

/** Fires before a step execution starts. */
export const BeforeStep = (): MethodDecorator =>
  listenerDecorator({ kind: 'step', phase: 'before' });

/** Fires after a step execution finishes (regardless of status). */
export const AfterStep = (): MethodDecorator =>
  listenerDecorator({ kind: 'step', phase: 'after' });

// ---------------------------------------------------------------------------
// Chunk-level listeners (3)
// ---------------------------------------------------------------------------

/** Fires before each chunk (read-process-write cycle) starts. */
export const BeforeChunk = (): MethodDecorator =>
  listenerDecorator({ kind: 'chunk', phase: 'before' });

/** Fires after each chunk finishes successfully. */
export const AfterChunk = (): MethodDecorator =>
  listenerDecorator({ kind: 'chunk', phase: 'after' });

/** Fires when a chunk throws (allows rollback hooks / telemetry). */
export const OnChunkError = (): MethodDecorator =>
  listenerDecorator({ kind: 'chunk', phase: 'on-error' });

// ---------------------------------------------------------------------------
// ItemRead listeners (3)
// ---------------------------------------------------------------------------

/** Fires before each item is read. */
export const BeforeRead = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-read', phase: 'before' });

/** Fires after each item is successfully read. */
export const AfterRead = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-read', phase: 'after' });

/** Fires when the reader throws. */
export const OnReadError = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-read', phase: 'on-error' });

// ---------------------------------------------------------------------------
// ItemProcess listeners (3)
// ---------------------------------------------------------------------------

/** Fires before each item is processed. */
export const BeforeProcess = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-process', phase: 'before' });

/** Fires after each item is successfully processed. */
export const AfterProcess = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-process', phase: 'after' });

/** Fires when the processor throws. */
export const OnProcessError = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-process', phase: 'on-error' });

// ---------------------------------------------------------------------------
// ItemWrite listeners (3)
// ---------------------------------------------------------------------------

/** Fires before the writer receives a chunk. */
export const BeforeWrite = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-write', phase: 'before' });

/** Fires after the writer successfully writes a chunk. */
export const AfterWrite = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-write', phase: 'after' });

/** Fires when the writer throws. */
export const OnWriteError = (): MethodDecorator =>
  listenerDecorator({ kind: 'item-write', phase: 'on-error' });

// ---------------------------------------------------------------------------
// Skip listeners (3)
//
// Skip listeners are not phase-based — each kind handles a distinct skip
// event emitted by the corresponding read/process/write. We store them
// under `kind: 'skip'` with `phase: 'after'` as a placeholder so the
// metadata shape is uniform; the dispatch table is built in Task 25.
// ---------------------------------------------------------------------------

/** Fires when a read is skipped (after the skip policy decides to skip). */
export const OnSkipRead = (): MethodDecorator =>
  listenerDecorator({ kind: 'skip', phase: 'after' });

/** Fires when a processed item is skipped. */
export const OnSkipProcess = (): MethodDecorator =>
  listenerDecorator({ kind: 'skip', phase: 'after' });

/** Fires when a write is skipped. */
export const OnSkipWrite = (): MethodDecorator =>
  listenerDecorator({ kind: 'skip', phase: 'after' });
