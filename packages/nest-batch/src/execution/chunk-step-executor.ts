import { Injectable } from '@nestjs/common';
import type { ChunkStepDefinition, ReaderRef, ProcessorRef, WriterRef } from '../core/ir';
import { RefKind } from '../core/ir';
import type { ItemReader, ItemProcessor, ItemWriter } from '../core/item';
import type { JobRepository } from '../core/repository';
import type { TransactionManager } from '../core/transaction';
import { StepStatus } from '../core/status';
import type { SkipPolicy, SkipContext } from '../policies/skip-policy';
import type { RetryPolicy, RetryContext } from '../policies/retry-policy';
import { compileSkipPolicy } from '../policies/skip-policy';
import { compileRetryPolicy } from '../policies/retry-policy';
import { SkipLimitExceededError, RetryLimitExceededError } from '../core/errors';
import type { ResolverMap } from './listener-invoker';
import { ListenerInvoker } from './listener-invoker';
import { resolveProviderToken, type ProviderResolvers } from './ref-resolver';

export interface ChunkExecutionContext {
  jobExecutionId: string;
  /** Step execution id, used to scope the chunk-progress checkpoint in the
   *  step's ExecutionContext (saved as `{ lastChunkIndex }`). */
  stepExecutionId: string;
  jobRepository: JobRepository;
  transactionManager: TransactionManager;
  listenerInvoker: ListenerInvoker;
  /** Map of resolved reader/processor/writer functions by name. */
  resolvers: Map<string, (...args: unknown[]) => unknown | Promise<unknown>>;
  jobExecutionId2: string; // unique key for listener resolver namespacing
  /** Optional skip listener resolver map. Keys follow the `on-skip:<kind>:<name>` shape. */
  skipListenerResolvers?: ResolverMap;
  /**
   * Optional map of provider-token id → already-resolved provider instance.
   * Populated by the JobExecutor (or test fixtures) so that
   * `RefKind.ProviderToken` refs on the reader/processor/writer slots can
   * be looked up without coupling the executor to the Nest DI container.
   */
  providerResolvers?: ProviderResolvers;
  /**
   * When set, the executor skips any chunk whose 0-based index is less
   * than or equal to this value. The reader is still advanced by
   * `chunkSize` calls per skipped chunk (so the data stream position
   * stays correct), but no read/process/write happens and `commitCount`
   * is not incremented. The checkpoint value is loaded from the prior
   * FAILED step execution's ExecutionContext by `JobExecutor`.
   */
  resumeFromChunkIndex?: number;
}

export interface ChunkExecutionResult {
  status: StepStatus;
  exitCode: string;
  exitMessage: string;
  readCount: number;
  writeCount: number;
  skipCount: number;
  commitCount: number;
}

/** Phase tag used by skip/retry policies. Mirrors the union in policy modules. */
type Phase = 'read' | 'process' | 'write';

/**
 * Outcome of a single per-phase attempt after skip/retry consultation.
 * - `ok`        — the operation succeeded; `value` is the op's return value.
 * - `skipped`   — the error was skippable (and within budget); the op was
 *                 abandoned, the on-skip listener was invoked, and `value` is
 *                 `undefined`.
 */
type PhaseResult<T> = { kind: 'ok'; value: T } | { kind: 'skipped' };

/**
 * Options for `runPhase`. `getSkipCount` is a closure over the executor's
 * live `skipCount` accumulator so the policy's budget check is consistent
 * with the accounting in the outer loop.
 */
interface RunPhaseOptions {
  phase: Phase;
  item: unknown;
  skipPolicy: SkipPolicy | null;
  retryPolicy: RetryPolicy | null;
  skipLimit: number;
  retryLimit: number;
  /** Live read of the executor's skipCount accumulator. */
  getSkipCount: () => number;
  /** Invoked when an error is actually skipped (within budget). The caller
   *  is responsible for incrementing its own skipCount here. */
  onSkip: (err: unknown) => Promise<void>;
}

@Injectable()
export class ChunkStepExecutor {
  async execute(
    step: ChunkStepDefinition,
    context: ChunkExecutionContext,
  ): Promise<ChunkExecutionResult> {
    const skipPolicy = step.skipPolicy ? compileSkipPolicy(step.skipPolicy) : null;
    const retryPolicy = step.retryPolicy ? compileRetryPolicy(step.retryPolicy) : null;
    const skipResolvers: ResolverMap = context.skipListenerResolvers ?? new Map();

    const skipLimit = step.skipPolicy?.limit ?? 0;
    const retryLimit = step.retryPolicy?.limit ?? 0;

    let readCount = 0;
    let writeCount = 0;
    let skipCount = 0;
    let commitCount = 0;
    // 0-based index of the chunk currently being assembled. Used by the
    // restart path to decide which chunks to skip and where to record
    // the last-committed checkpoint.
    let chunkIndex = 0;

    try {
      // Resolve inside the try block so a missing provider-token ref
      // surfaces as FAILED/{exitMessage: <err>}, matching the tasklet
      // executor's contract — not as a propagated throw.
      const reader = this.resolveReader(step.reader, context);
      const processor = step.processor ? this.resolveProcessor(step.processor, context) : null;
      const writer = this.resolveWriter(step.writer, context);
      // Outer loop: keep reading chunks until reader returns null
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // ---- SKIP PHASE (restart-only): drain up to chunkSize items so
        // the reader advances past already-committed chunks, but skip
        // the read/process/write pipeline entirely. commitCount is not
        // incremented (those chunks were already counted in the prior
        // run) and no checkpoint is written (the prior run owns it).
        if (
          context.resumeFromChunkIndex !== undefined &&
          chunkIndex <= context.resumeFromChunkIndex
        ) {
          let drained = 0;
          for (let i = 0; i < step.chunkSize; i++) {
            const item = await reader.read();
            if (item == null) break;
            drained += 1;
          }
          if (drained === 0) break; // EOF reached while skipping
          chunkIndex += 1;
          continue;
        }

        const items: unknown[] = [];
        let eof = false;

        // ---- READ PHASE: per-item retry+skip ----
        for (let i = 0; i < step.chunkSize && !eof; i++) {
          const r = await this.runPhase<unknown>(() => reader.read(), {
            phase: 'read',
            item: null,
            skipPolicy,
            retryPolicy,
            skipLimit,
            retryLimit,
            getSkipCount: () => skipCount,
            onSkip: async (err) => {
              skipCount += 1;
              await context.listenerInvoker.invokeOnSkipRead(skipResolvers, err, null);
            },
          });
          if (r.kind === 'skipped') continue;
          if (r.value == null) {
            // Natural EOF from the reader
            eof = true;
            break;
          }
          items.push(r.value);
          readCount += 1;
        }
        if (items.length === 0) break; // EOF (either before first read or after skips)

        // ---- PROCESS PHASE: per-item retry+skip ----
        const processed: unknown[] = [];
        for (const item of items) {
          if (!processor) {
            processed.push(item);
            continue;
          }
          const r = await this.runPhase<unknown>(() => processor.process(item), {
            phase: 'process',
            item,
            skipPolicy,
            retryPolicy,
            skipLimit,
            retryLimit,
            getSkipCount: () => skipCount,
            onSkip: async (err) => {
              skipCount += 1;
              await context.listenerInvoker.invokeOnSkipProcess(skipResolvers, item, err);
            },
          });
          if (r.kind === 'skipped') continue;
          if (r.value !== null && r.value !== undefined) {
            processed.push(r.value);
          } else {
            // Processor filtered the item out (returned null/undefined) — not a
            // skip-policy skip, but counts as a skip for accounting parity.
            skipCount += 1;
          }
        }

        // ---- WRITE PHASE: per-chunk retry+skip, wrapped in transaction ----
        if (processed.length > 0) {
          const r = await this.runPhase<{ written: number; skipped: number } | void>(
            () =>
              context.transactionManager.withTransaction(async () => {
                return writer.write(processed);
              }),
            {
              phase: 'write',
              item: processed,
              skipPolicy,
              retryPolicy,
              skipLimit,
              retryLimit,
              getSkipCount: () => skipCount,
              onSkip: async (err) => {
                skipCount += 1;
                await context.listenerInvoker.invokeOnSkipWrite(skipResolvers, processed, err);
              },
            },
          );
          if (r.kind === 'ok') {
            if (r.value) {
              writeCount += r.value.written;
              skipCount += r.value.skipped;
            } else {
              writeCount += processed.length;
            }
          }
          // If the write was skipped, writeCount is not incremented and the
          // chunk is still considered "committed" (commitCount++) so that
          // progress tracking reflects that we moved past it.
        }

        // Persist the last-committed-chunk checkpoint in the step's
        // ExecutionContext. The next restart will read this value and
        // skip every chunk with index ≤ `lastChunkIndex`. The save is
        // intentionally outside the per-chunk transaction: the
        // checkpoint reflects "we successfully moved past this chunk",
        // and we only reach this line after the write completed
        // (either OK or skipped — both are forward progress).
        // eslint-disable-next-line no-console
        console.log(`[DEBUG] chunk-executor: about to save checkpoint chunkIndex=${chunkIndex}`);
        await context.jobRepository.saveExecutionContext(
          { stepExecutionId: context.stepExecutionId },
          { data: { lastChunkIndex: chunkIndex }, version: 0 },
        );
        // eslint-disable-next-line no-console
        console.log(`[DEBUG] chunk-executor: checkpoint saved`);

        commitCount += 1;
        chunkIndex += 1;
      }

      return {
        status: StepStatus.COMPLETED,
        exitCode: 'COMPLETED',
        exitMessage: '',
        readCount,
        writeCount,
        skipCount,
        commitCount,
      };
    } catch (err) {
      return {
        status: StepStatus.FAILED,
        exitCode: 'FAILED',
        exitMessage: err instanceof Error ? err.message : String(err),
        readCount,
        writeCount,
        skipCount,
        commitCount,
      };
    }
  }

  /**
   * Run a single per-phase operation (one read, one process, or one write) with
   * skip/retry policy consultation. Throws when the operation cannot be
   * skipped (either non-skippable error or skip-limit exceeded) or when
   * retries are exhausted.
   *
   * The contract on budget accounting:
   *   - The caller's `skipCount` accumulator is consulted *before* a skip is
   *     honored. If the post-skip count would exceed the limit, the error
   *     becomes a `SkipLimitExceededError` instead of a skip.
   *   - The caller's `onSkip` callback is responsible for incrementing the
   *     skipCount; it runs only when a skip is actually honored.
   */
  private async runPhase<T>(
    op: () => Promise<T>,
    options: RunPhaseOptions,
  ): Promise<PhaseResult<T>> {
    let attempt = 1;
    // Outer safety cap: when a retry policy exists, allow many iterations;
    // the policy's `canRetry` is the actual gate. When no retry policy,
    // exactly one attempt.
    const outerCap = options.retryPolicy ? 999 : 1;

    while (attempt <= outerCap) {
      try {
        const value = await op();
        return { kind: 'ok', value };
      } catch (err) {
        // 1) Skip consultation: is this error skippable, and is there budget?
        if (options.skipPolicy) {
          // Use the policy's `shouldSkip` with `skipCount: 0` to get a pure
          // membership check (the policy's own budget gate is bypassed).
          // We apply the budget ourselves with the caller's live accounting.
          const membership: SkipContext = {
            item: options.item,
            phase: options.phase,
            skipCount: 0,
            skipLimit: options.skipLimit,
          };
          if (options.skipPolicy.shouldSkip(err, membership)) {
            // Error is in the skippable list. Now check the budget: would
            // honoring this skip exceed the limit?
            const projected = options.getSkipCount() + 1;
            if (projected > options.skipLimit) {
              throw new SkipLimitExceededError(options.skipLimit);
            }
            await options.onSkip(err);
            console.log('[DBG-RP] about to return skipped');
            return { kind: 'skipped' };
          }
          // Not in the skippable list — fall through to retry/throw.
        }

        // 2) Retry consultation
        if (options.retryPolicy) {
          const retryCtx: RetryContext = {
            item: options.item,
            phase: options.phase,
            attempt,
            retryLimit: options.retryLimit,
          };
          if (options.retryPolicy.canRetry(err, retryCtx)) {
            const ms = options.retryPolicy.backoffMs(attempt);
            if (ms > 0) await new Promise((r) => setTimeout(r, ms));
            attempt += 1;
            continue;
          }
          // canRetry returned false. Distinguish "exhausted" from "not
          // retryable" by re-checking membership with an effectively
          // infinite budget.
          if (attempt > options.retryLimit) {
            const isRetryable = options.retryPolicy.canRetry(err, {
              item: options.item,
              phase: options.phase,
              attempt: 1,
              retryLimit: Number.POSITIVE_INFINITY,
            });
            if (isRetryable) {
              throw new RetryLimitExceededError(options.retryLimit);
            }
          }
        }

        // 3) Neither skippable nor retryable: re-throw the original error.
        throw err;
      }
    }

    // Defensive: the outer cap should never be reached when a retry policy
    // gates us, but if no retry policy exists and the very first attempt
    // somehow re-entered the loop, fall through with a clear failure.
    throw new Error(
      `ChunkStepExecutor: phase "${options.phase}" exhausted attempts without a retry policy`,
    );
  }

  private resolveReader(ref: ReaderRef, context: ChunkExecutionContext): ItemReader {
    if (ref.kind === RefKind.BuilderLambda && ref.fn) {
      const result = ref.fn();
      if (typeof result === 'function') {
        return { read: result as ItemReader['read'] };
      }
      if (result !== null && typeof result === 'object' && typeof (result as ItemReader).read === 'function') {
        return result as ItemReader;
      }
      return { read: ref.fn as ItemReader['read'] };
    }
    if (ref.kind === RefKind.ProviderToken) {
      return resolveProviderToken<ItemReader>('reader', ref, context.providerResolvers);
    }
    if (ref.kind === RefKind.Method && ref.classToken && ref.methodName) {
      const key = `${context.jobExecutionId2}::reader::${ref.classToken}::${ref.methodName}`;
      const fn = context.resolvers.get(key);
      if (!fn) throw new Error(`Reader not resolved: ${ref.classToken}.${ref.methodName}`);
      return { read: fn as ItemReader['read'] };
    }
    throw new Error(`Unsupported reader ref kind: ${ref.kind}`);
  }

  private resolveProcessor(ref: ProcessorRef, context: ChunkExecutionContext): ItemProcessor {
    if (ref.kind === RefKind.BuilderLambda && ref.fn) {
      const result = ref.fn();
      if (typeof result === 'function') {
        return { process: result as ItemProcessor['process'] };
      }
      if (result !== null && typeof result === 'object' && typeof (result as ItemProcessor).process === 'function') {
        return result as ItemProcessor;
      }
      return { process: ref.fn as ItemProcessor['process'] };
    }
    if (ref.kind === RefKind.ProviderToken) {
      return resolveProviderToken<ItemProcessor>('processor', ref, context.providerResolvers);
    }
    if (ref.kind === RefKind.Method && ref.classToken && ref.methodName) {
      const key = `${context.jobExecutionId2}::processor::${ref.classToken}::${ref.methodName}`;
      const fn = context.resolvers.get(key);
      if (!fn) throw new Error(`Processor not resolved: ${ref.classToken}.${ref.methodName}`);
      return { process: fn as ItemProcessor['process'] };
    }
    throw new Error(`Unsupported processor ref kind: ${ref.kind}`);
  }

  private resolveWriter(ref: WriterRef, context: ChunkExecutionContext): ItemWriter {
    if (ref.kind === RefKind.BuilderLambda && ref.fn) {
      const result = ref.fn();
      if (typeof result === 'function') {
        return { write: result as ItemWriter['write'] };
      }
      if (result !== null && typeof result === 'object' && typeof (result as ItemWriter).write === 'function') {
        return result as ItemWriter;
      }
      return { write: ref.fn as ItemWriter['write'] };
    }
    if (ref.kind === RefKind.ProviderToken) {
      return resolveProviderToken<ItemWriter>('writer', ref, context.providerResolvers);
    }
    if (ref.kind === RefKind.Method && ref.classToken && ref.methodName) {
      const key = `${context.jobExecutionId2}::writer::${ref.classToken}::${ref.methodName}`;
      const fn = context.resolvers.get(key);
      if (!fn) throw new Error(`Writer not resolved: ${ref.classToken}.${ref.methodName}`);
      return { write: fn as ItemWriter['write'] };
    }
    throw new Error(`Unsupported writer ref kind: ${ref.kind}`);
  }
}
