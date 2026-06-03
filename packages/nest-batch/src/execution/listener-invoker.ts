/**
 * ListenerInvoker — orchestrates lifecycle listeners around step / chunk / job /
 * item / skip execution.
 *
 * Supports the 7 listener kinds declared in `ListenerKind` (job / step / chunk /
 * item-read / item-process / item-write / skip) with proper failure policy:
 *
 *   - default                → listener throw propagates
 *   - `nonCritical: true`    → log + continue with the next listener
 *
 * Two resolver-map shapes are supported:
 *
 *   1. Legacy (Task 17) — `Map<string, ListenerResolver>` keyed by
 *      `${phase}-${kind}:${name}` (e.g. `before-step:MyListener`). The
 *      convenience methods `invokeBeforeStep / invokeAfterStep /
 *      invokeOnErrorStep` operate on this shape and remain in place for
 *      backward compatibility with the Wave-3 step executor.
 *
 *   2. Current (Task 20) — `Map<string, ListenerEntry>` keyed by
 *      `${phase}:${kind}:${name}` (e.g. `before:step:MyListener`,
 *      `on-skip:read:MySkipListener`). This is the shape consumed by
 *      `invokeBefore / invokeAfter / invokeOnError / invokeOnSkipRead /
 *      invokeOnSkipProcess / invokeOnSkipWrite` and is the source of truth for
 *      all 7 listener kinds going forward.
 *
 * Registration order is preserved (Map iteration is insertion-ordered in JS).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ExecutionContext } from '../core/repository';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Listener function — signature is determined by the listener's kind/phase.
 *
 * Typed as `any[]` rather than `unknown[]` so listeners can be authored with
 * the narrower, kind-specific signatures (e.g. `(ctx) => void`,
 * `(item, ctx) => void`, `(err, item) => void`) without TypeScript rejecting
 * the assignment to `ListenerEntry.fn`. The runtime contract is enforced by
 * the invoker's kind-aware `buildCallArgs`, not by the type system.
 */
export type ListenerFn = (...args: any[]) => any;

/**
 * Resolver-map entry used by the current (Task 20) API.
 *
 * - `fn`           — the actual listener function to invoke
 * - `nonCritical`  — when true, failures from this listener are logged and
 *                    suppressed; otherwise the failure propagates out of the
 *                    `invoke*` call and aborts the surrounding executor.
 */
export interface ListenerEntry {
  fn: ListenerFn;
  nonCritical?: boolean;
}

/** Resolver map consumed by the current (Task 20) `invoke*` methods. */
export type ResolverMap = Map<string, ListenerEntry>;

// ---------------------------------------------------------------------------
// Legacy types (Task 17 backward compatibility)
// ---------------------------------------------------------------------------

/** Phase prefix constants used by the legacy convenience methods. */
export const LISTENER_PHASE_PREFIX = {
  BeforeStep: 'before-step:',
  AfterStep: 'after-step:',
  OnStepError: 'on-step-error:',
} as const;

/** Legacy resolver function type — bare callable, no per-entry metadata. */
export type ListenerResolver = (...args: unknown[]) => unknown | Promise<unknown>;

export interface StepListenerContext {
  jobExecutionId: string;
  stepExecutionId: string;
  getExecutionContext?: () => Promise<ExecutionContext>;
  saveExecutionContext?: (ctx: ExecutionContext) => Promise<void>;
}

export interface StepListenerResult {
  status: string;
  exitCode?: string;
  exitMessage?: string;
}

// ---------------------------------------------------------------------------
// Current (Task 20) phase / kind constants
// ---------------------------------------------------------------------------

/**
 * Phase segment for the current key format `${phase}:${kind}:${name}`.
 *
 * - `before`     — `invokeBefore`
 * - `after`      — `invokeAfter`
 * - `on-error`   — `invokeOnError` (job / step / chunk)
 * - `on-skip`    — `invokeOnSkipRead / Process / Write` (the trailing kind
 *                  segment is one of `read` / `process` / `write`)
 */
export const LISTENER_PHASE = {
  Before: 'before',
  After: 'after',
  OnError: 'on-error',
  OnSkip: 'on-skip',
} as const;

/** Phase kinds that share the standard `${phase}:${kind}:${name}` shape. */
export type LifecyclePhaseKind =
  | 'job'
  | 'step'
  | 'chunk'
  | 'item-read'
  | 'item-process'
  | 'item-write';

/** Phase kinds accepted by `invokeOnError` (subset of the lifecycle kinds). */
export type OnErrorKind = 'job' | 'step' | 'chunk';

/**
 * Sub-kinds for the `on-skip` phase. The resolver key looks like
 * `on-skip:${SkipSubKind}:${name}` — for example `on-skip:read:MySkipListener`.
 */
export type SkipSubKind = 'read' | 'process' | 'write';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

@Injectable()
export class ListenerInvoker {
  private readonly logger = new Logger(ListenerInvoker.name);

  // -------------------------------------------------------------------------
  // Current (Task 20) API — supports all 7 listener kinds with failure policy
  // -------------------------------------------------------------------------

  /**
   * Invoke every `before:<kind>:<name>` resolver, in registration order.
   *
   * Listener signature depends on `<kind>`:
   *   - `job` / `chunk`   — `fn(ctx)`
   *   - `step`            — `fn(ctx, result)` (the optional `args` is the result)
   *   - `item-read` / `item-process` / `item-write` — `fn(item, ctx)` (the
   *     optional `args` is the item, placed in the first position by
   *     convention)
   */
  async invokeBefore(
    resolvers: ResolverMap,
    kind: LifecyclePhaseKind,
    ctx: ListenerContext,
    args?: unknown,
  ): Promise<void> {
    const callArgs = this.buildCallArgs(kind, ctx, args);
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.Before}:${kind}:`, callArgs);
  }

  /**
   * Invoke every `after:<kind>:<name>` resolver, in registration order.
   * Same signature rules as `invokeBefore`.
   */
  async invokeAfter(
    resolvers: ResolverMap,
    kind: LifecyclePhaseKind,
    ctx: ListenerContext,
    args?: unknown,
  ): Promise<void> {
    const callArgs = this.buildCallArgs(kind, ctx, args);
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.After}:${kind}:`, callArgs);
  }

  /**
   * Invoke every `on-error:<kind>:<name>` resolver, in registration order.
   * Listener signature is `fn(ctx, err)`.
   */
  async invokeOnError(
    resolvers: ResolverMap,
    kind: OnErrorKind,
    ctx: ListenerContext,
    err: unknown,
  ): Promise<void> {
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.OnError}:${kind}:`, [ctx, err]);
  }

  /** Invoke every `on-skip:read:<name>` resolver. Listener signature: `fn(err, item)`. */
  async invokeOnSkipRead(
    resolvers: ResolverMap,
    err: unknown,
    item: unknown,
  ): Promise<void> {
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.OnSkip}:read:`, [err, item]);
  }

  /** Invoke every `on-skip:process:<name>` resolver. Listener signature: `fn(item, err)`. */
  async invokeOnSkipProcess(
    resolvers: ResolverMap,
    item: unknown,
    err: unknown,
  ): Promise<void> {
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.OnSkip}:process:`, [item, err]);
  }

  /** Invoke every `on-skip:write:<name>` resolver. Listener signature: `fn(items, err)`. */
  async invokeOnSkipWrite(
    resolvers: ResolverMap,
    items: unknown[],
    err: unknown,
  ): Promise<void> {
    await this.invokeMatching(resolvers, `${LISTENER_PHASE.OnSkip}:write:`, [items, err]);
  }

  // -------------------------------------------------------------------------
  // Legacy (Task 17) convenience methods — preserved for backward compat
  // -------------------------------------------------------------------------

  /**
   * Invoke all `before-step:*` resolvers in Map insertion order. Operates on
   * the legacy `Map<string, ListenerResolver>` shape; the current
   * `invokeBefore(resolvers, 'step', ...)` should be preferred for new code.
   */
  async invokeBeforeStep(
    resolvers: Map<string, ListenerResolver>,
    ctx: StepListenerContext,
  ): Promise<void> {
    for (const [name, fn] of resolvers.entries()) {
      if (name.startsWith(LISTENER_PHASE_PREFIX.BeforeStep)) {
        await fn(ctx);
      }
    }
  }

  /**
   * Invoke all `after-step:*` resolvers, receiving the step result as the
   * second argument. Legacy shape; see `invokeAfter(resolvers, 'step', ...)`
   * for the current API.
   */
  async invokeAfterStep(
    resolvers: Map<string, ListenerResolver>,
    ctx: StepListenerContext,
    result: StepListenerResult,
  ): Promise<void> {
    for (const [name, fn] of resolvers.entries()) {
      if (name.startsWith(LISTENER_PHASE_PREFIX.AfterStep)) {
        await fn(ctx, result);
      }
    }
  }

  /**
   * Invoke all `on-step-error:*` resolvers, receiving the thrown error as the
   * second argument. Legacy shape; see `invokeOnError(resolvers, 'step', ...)`
   * for the current API.
   */
  async invokeOnErrorStep(
    resolvers: Map<string, ListenerResolver>,
    ctx: StepListenerContext,
    err: unknown,
  ): Promise<void> {
    for (const [name, fn] of resolvers.entries()) {
      if (name.startsWith(LISTENER_PHASE_PREFIX.OnStepError)) {
        await fn(ctx, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Compute the positional argument list to forward to a before/after
   * listener, based on the listener's kind.
   *
   * - `job` / `chunk`   → `[ctx]`
   * - `step`            → `[ctx, args]`   (args is the result)
   * - `item-read` /
   *   `item-process` /
   *   `item-write`      → `[args, ctx]`   (args is the item, leading position)
   */
  private buildCallArgs(
    kind: LifecyclePhaseKind,
    ctx: ListenerContext,
    args: unknown,
  ): unknown[] {
    switch (kind) {
      case 'item-read':
      case 'item-process':
      case 'item-write':
        return [args, ctx];
      case 'step':
        return [ctx, args];
      case 'job':
      case 'chunk':
        return [ctx];
      default: {
        // exhaustive guard
        const _exhaustive: never = kind;
        void _exhaustive;
        return [ctx];
      }
    }
  }

  /**
   * Iterate the resolver map in insertion order, invoke every entry whose key
   * starts with `prefix`, and apply the failure policy:
   *
   *   - if the entry is missing / the function rejects:
   *       - `nonCritical: true`  → log a warning, swallow, continue
   *       - otherwise            → re-throw, aborting the surrounding executor
   */
  private async invokeMatching(
    resolvers: ResolverMap,
    prefix: string,
    args: unknown[],
  ): Promise<void> {
    for (const [key, entry] of resolvers.entries()) {
      if (!key.startsWith(prefix)) continue;
      try {
        await entry.fn(...args);
      } catch (err) {
        if (entry.nonCritical) {
          this.logger.warn(
            `[ListenerInvoker] non-critical listener "${key}" failed: ${formatError(err)}`,
          );
          continue;
        }
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared listener-context payload. All fields are optional because the
 *  caller (executor) may not always have a stepExecutionId at hand (e.g. for
 *  job-level listeners). */
export interface ListenerContext {
  jobExecutionId: string;
  stepExecutionId?: string;
  stepName?: string;
  /** Arbitrary, executor-supplied metadata (transaction context, etc.). */
  [extra: string]: unknown;
}

function formatError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
