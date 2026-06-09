/**
 * Pure partition helpers for chunked steps.
 *
 * This module is the single source of truth for partition validation
 * and the default partition-range shape. It is deliberately
 * dependency-light: no `@nest-batch/bullmq`, no `@nest-batch/kafka`,
 * no ORMs, no cron — verified by
 * `packages/core/tests/core/boundary/no-forbidden-imports.test.ts`.
 *
 * The helpers are consumed by:
 *   - `packages/core/src/compiler/definition-compiler.ts` (validation
 *     at compile time),
 *   - `packages/core/src/core/validation/definition-validator.ts`
 *     (cross-checks the resolved `JobDefinition`),
 *   - `packages/core/src/execution/in-process-execution-strategy.ts`
 *     (the in-process adapter's partition guard),
 *   - `packages/bullmq/src/bullmq-runtime.service.ts` (the BullMQ
 *     strategy's enqueue fan-out + the worker's `partitionIndex`
 *     enforcement),
 *   - `packages/kafka/src/kafka-runtime.service.ts` (the Kafka
 *     mirror — T9).
 *
 * Pinned by:
 *   - `docs/RELEASE-0.2.0.md §6` — the v1 partition contract.
 *   - `packages/bullmq/tests/partition-invariant.test.ts` — T-AC-3
 *     first half (the BullMQ side).
 *   - `packages/kafka/tests/partition-invariant.test.ts` — T-AC-3
 *     second half (the Kafka side, T9).
 */

import type { ChunkPartitionConfig } from './core/ir/step-definition';

/**
 * Error code returned / thrown by the partition helpers. Stable for
 * callers that want to switch on it (the BullMQ / Kafka workers
 * surface this in their `exitMessage` when a partition payload is
 * out of range).
 */
export const INVALID_PARTITION_INDEX = 'INVALID_PARTITION_INDEX';

/**
 * Thrown when a partition's `count` is not a positive integer, or
 * when a runtime-resolved `partitionIndex` falls outside `[0, count)`.
 *
 * Distinct from `InvalidFlowGraphError` because this is a *value*
 * problem (the input is out of range) rather than a *graph*
 * problem (the step graph is malformed). The `code` is stable.
 */
export class InvalidPartitionsError extends Error {
  readonly code: string;
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'InvalidPartitionsError';
    this.code = 'INVALID_PARTITIONS';
  }
}

/**
 * Validate a `ChunkPartitionConfig` at compile time. Throws
 * `InvalidPartitionsError` when the config is structurally invalid:
 *
 *   - `count` is not a finite integer
 *   - `count <= 0` (a partition count of zero is meaningless)
 *   - `range` is set but is not a function
 *
 * `count === 1` is allowed but the runtime short-circuits it to
 * the non-partitioned path; we still validate it here so a typo
 * (`count: 0` vs `count: 1`) fails loudly at the compiler.
 */
export function validatePartitions(partitions: ChunkPartitionConfig | undefined): void {
  if (partitions === undefined) return;
  if (!Number.isInteger(partitions.count) || partitions.count <= 0) {
    throw new InvalidPartitionsError(
      `ChunkStepDefinition.partitions.count must be a positive integer, got ${String(
        partitions.count,
      )}`,
      { count: partitions.count },
    );
  }
  if (partitions.range !== undefined && typeof partitions.range !== 'function') {
    throw new InvalidPartitionsError(
      `ChunkStepDefinition.partitions.range must be a function when present, got ${typeof partitions.range}`,
      { rangeType: typeof partitions.range },
    );
  }
}

/**
 * The default even-split partition range, given a known total item
 * count. The formula mirrors the v1 contract in
 * `docs/RELEASE-0.2.0.md §6.1`:
 *
 *   partition `i` of `n` over `total` items:
 *     [floor(i * total / n), floor((i+1) * total / n))
 *
 * Pure function. Exported so hosts that want the "even split"
 * behaviour without re-implementing the math can reuse it:
 *
 *   const r = defaultRange(i, n, total);
 *   partitions: { count: n, range: (i, n) => defaultRange(i, n, total) }
 *
 * `total` is required because the runtime has no generic way to
 * count the input — only the host's reader knows. The math is
 * robust to `total === 0` (returns `[0, 0)` for every partition).
 */
export function defaultRange(
  i: number,
  n: number,
  total: number,
): readonly [from: number, to: number] {
  if (!Number.isInteger(i) || i < 0 || i >= n) {
    throw new InvalidPartitionsError(
      `defaultRange: partition index ${i} out of range [0, ${n})`,
      { i, n },
    );
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidPartitionsError(`defaultRange: count ${n} must be a positive integer`, { n });
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new InvalidPartitionsError(
      `defaultRange: total ${total} must be a non-negative finite number`,
      { total },
    );
  }
  const from = Math.floor((i * total) / n);
  const to = Math.floor(((i + 1) * total) / n);
  return [from, to] as const;
}

/**
 * Runtime check that a `partitionIndex` on a job payload is in
 * range for the configured `count`. Throws
 * `InvalidPartitionsError` when the index is undefined, not an
 * integer, negative, or `>= count`.
 *
 * The BullMQ / Kafka worker's `processJob` calls this with the
 * payload's `partitionIndex` and the step's `partitions.count` so
 * an out-of-range index becomes a hard step failure (the runtime
 * surfaces it as `FAILED` with the invariant violation in the
 * `exitMessage`).
 */
export function enforcePartitionIndex(
  partitionIndex: number | undefined,
  count: number,
): void {
  if (partitionIndex === undefined) {
    throw new InvalidPartitionsError(
      `partitionIndex is required for a partitioned step (count=${count})`,
      { count },
    );
  }
  if (
    !Number.isInteger(partitionIndex) ||
    partitionIndex < 0 ||
    partitionIndex >= count
  ) {
    throw new InvalidPartitionsError(
      `partitionIndex ${partitionIndex} is out of range [0, ${count})`,
      { partitionIndex, count },
    );
  }
}

/**
 * Resolved partition info passed through the runtime. Built from
 * the step's `partitions` config and the BullMQ / Kafka payload's
 * `partitionIndex`. The runtime uses this to:
 *   - bound the chunk executor's read loop (when the host provided
 *     a `range` resolver),
 *   - tag the persisted `StepExecution` for diagnostics (a future
 *     task; the v1 contract only requires the chunk executor to
 *     honour the range).
 */
export interface ResolvedPartition {
  readonly count: number;
  readonly index: number;
  /** The partition's resolved `[from, to)` range, or `undefined`
   *  when the step did not provide a `range` resolver (the default
   *  behaviour is "read until EOF"). */
  readonly range?: readonly [from: number, to: number];
}

/**
 * Resolve a partition's metadata from the step's `partitions`
 * config and the transport's `partitionIndex`. Calls
 * `enforcePartitionIndex` to fail loudly on out-of-range indices.
 *
 * The `range` is computed only when the step provides a resolver;
 * otherwise the returned `ResolvedPartition` is `count` + `index`
 * with no `range`, and the chunk executor reads until EOF.
 */
export function resolvePartition(args: {
  partitions: ChunkPartitionConfig;
  partitionIndex: number | undefined;
}): ResolvedPartition {
  enforcePartitionIndex(args.partitionIndex, args.partitions.count);
  const index = args.partitionIndex as number;
  if (args.partitions.range === undefined) {
    return { count: args.partitions.count, index };
  }
  const range = args.partitions.range(index, args.partitions.count);
  return { count: args.partitions.count, index, range };
}
