import type { ReaderRef, ProcessorRef, WriterRef, TaskletRef, ItemListenerRef } from './refs';
import type { SkipPolicyConfig, RetryPolicyConfig } from './policy-config';

export type StepDefinition = ChunkStepDefinition | TaskletStepDefinition;

/**
 * v1 partition configuration for a chunk step. Pinned by
 * `docs/RELEASE-0.2.0.md §6.1` and the T-AC-3 acceptance test.
 *
 * - `count` is the number of partitions. `count === 1` (or the
 *   field being absent) preserves the 0.1.0 "one job per step"
 *   behaviour. `count >= 2` activates the partition-aware runtime:
 *   the transport enqueues `count` jobs, each with a distinct
 *   `partitionIndex`, and the worker body offsets the chunk loop
 *   by the partition's range.
 * - `range` is an optional half-open `[from, to]` resolver. When
 *   omitted, the runtime treats each partition as "reads from the
 *   start" (the host's reader is responsible for not
 *   double-processing). When provided, the chunk executor bounds
 *   its read loop to `to - from` items.
 */
export interface ChunkPartitionConfig {
  /** Number of partitions; must be a positive integer. */
  readonly count: number;
  /**
   * Optional partition-range resolver. Given the partition index
   * `i` and the total `n`, return a half-open `[from, to]` range
   * that the partition consumes. The default behaviour (when
   * omitted) is to read until EOF on every partition; hosts that
   * want an even split should provide a closure that captures the
   * total item count (the runtime has no generic "even split"
   * because the total is host-known).
   */
  readonly range?: (i: number, n: number) => readonly [from: number, to: number];
}

export interface ChunkStepDefinition {
  kind: 'chunk';
  id: string;
  chunkSize: number;
  reader: ReaderRef;
  processor?: ProcessorRef;
  writer: WriterRef;
  skipPolicy?: SkipPolicyConfig;
  retryPolicy?: RetryPolicyConfig;
  listeners: ItemListenerRef[];
  /**
   * Optional partition configuration. When absent, the step
   * runs as a single non-partitioned unit (the 0.1.0 behaviour).
   * When present with `count >= 2`, the transport activates
   * partition orchestration — see `docs/RELEASE-0.2.0.md §6` and
   * `packages/core/src/partition-helpers.ts` for the contract.
   */
  readonly partitions?: ChunkPartitionConfig;
}

export interface TaskletStepDefinition {
  kind: 'tasklet';
  id: string;
  tasklet: TaskletRef;
  listeners: ItemListenerRef[];
}
