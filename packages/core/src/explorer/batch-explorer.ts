import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import 'reflect-metadata';
import {
  BATCH_JOB_METADATA,
  BATCH_STEP_METADATA,
  BATCH_TASKLET_METADATA,
  BATCH_LISTENER_METADATA,
  BATCH_TRANSITION_METADATA,
} from '../decorators/constants';
import type { JobableOptions, StepableOptions } from '../decorators';
import type { ListenerKind, ListenerPhase } from '../core/ir/listener-definition';

/**
 * Raw shape of a discovered batch job, as it appears immediately after the
 * explorer walks the Nest provider tree. The {@link DiscoveredJob} contains
 * only metadata + class reference + (optionally) the resolved DI instance.
 *
 * It is intentionally NOT a `JobDefinition` yet — the {@link DefinitionCompiler}
 * (Task 8) is responsible for resolving the prototype methods into concrete
 * `ListenerRef` / `TaskletRef` / `ReaderRef` / `ProcessorRef` / `WriterRef` /
 * `TransitionRef` records and for choosing a start step.
 */
export interface DiscoveredJob {
  /** The @Jobable-decorated class reference. */
  classRef: Function;
  /** The Nest-resolved DI instance, when available. May be `undefined` for
   *  factories or providers that have not been instantiated yet. */
  instance?: unknown;
  /** Raw options passed to `@Jobable(...)`. */
  jobOptions: JobableOptions;
  /** Every `@Stepable` method on the class prototype, in declaration order. */
  stepMethods: DiscoveredStep[];
  /** Every listener-decorated method on the class prototype, in declaration order. */
  listenerMethods: DiscoveredListener[];
  /** Every `@OnTransition` method on the class prototype, in declaration order. */
  transitionMethods: DiscoveredTransition[];
}

/** A `@Stepable` method. `isTasklet` is true if `@Tasklet` was also applied. */
export interface DiscoveredStep {
  methodName: string;
  options: StepableOptions;
  isTasklet: boolean;
}

/** A listener-decorated method (any of the 7 kinds). */
export interface DiscoveredListener {
  methodName: string;
  kind: ListenerKind;
  phase: ListenerPhase;
  nonCritical?: boolean;
}

/**
 * A `@OnTransition` method. `onStatus` is the string name of a
 * `FlowExecutionStatus` (e.g. `'COMPLETED'`, `'FAILED'`, `'STOPPED'`).
 * `toStep === null` means the transition ends the flow.
 */
export interface DiscoveredTransition {
  methodName: string;
  fromStep: string;
  onStatus: string;
  toStep: string | null;
}

/**
 * Minimal shape required from an `InstanceWrapper`-like object. We accept
 * this loose shape (rather than requiring the full Nest `InstanceWrapper`
 * class) so that:
 *  1. tests can pass plain `{ metatype, instance }` objects without booting
 *     a Nest application, and
 *  2. future Nest versions that change the wrapper's internal shape will
 *     still work as long as `metatype` + `instance` are preserved.
 */
export interface ProviderLike {
  metatype?: Function;
  instance?: unknown;
}

/**
 * `BatchExplorer` is a Nest `OnModuleInit` provider that walks every
 * provider registered in the application, looks for classes carrying
 * `@Jobable(...)` metadata, and records every `@Stepable` / `@Tasklet` /
 * listener / `@OnTransition` method on each discovered class.
 *
 * The actual `JobDefinition` IR is produced downstream by the
 * `DefinitionCompiler` (Task 8). The explorer only collects the raw
 * metadata; it does not validate it, compile references, or register jobs.
 *
 * Mirrors the pattern used by `@nestjs/schedule` (`SchedulerExplorer`) and
 * `@nestjs/cqrs` (`Explorer`).
 */
@Injectable()
export class BatchExplorer implements OnModuleInit {
  private readonly logger = new Logger(BatchExplorer.name);
  private discovered: DiscoveredJob[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  /** Hook called by Nest once the DI container is ready. */
  onModuleInit(): void {
    const providers = this.discovery.getProviders();
    this.discovered = this.discoverFromProviders(providers as ProviderLike[]);
  }

  /**
   * Returns the snapshot of jobs collected at `onModuleInit` time. The
   * returned array is `readonly` — callers MUST NOT mutate it.
   */
  getDiscovered(): readonly DiscoveredJob[] {
    return this.discovered;
  }

  /**
   * Pure provider-walk: given an array of `InstanceWrapper`-like objects,
   * returns the list of `DiscoveredJob`s. Does not require a Nest container.
   *
   * The `onModuleInit` hook delegates here. Tests call this directly.
   */
  discoverFromProviders(providers: ProviderLike[]): DiscoveredJob[] {
    const out: DiscoveredJob[] = [];
    for (const wrapper of providers) {
      const metatype = wrapper.metatype;
      if (!metatype) continue;

      const jobOptions = Reflect.getMetadata(BATCH_JOB_METADATA, metatype) as
        | JobableOptions
        | undefined;
      if (!jobOptions) continue;

      out.push({
        classRef: metatype,
        instance: wrapper.instance,
        jobOptions,
        stepMethods: this.collectStepMethods(metatype.prototype),
        listenerMethods: this.collectListenerMethods(metatype.prototype),
        transitionMethods: this.collectTransitionMethods(metatype.prototype),
      });

      this.logger.log(`Discovered job: ${jobOptions.id}`);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Step methods
  // -------------------------------------------------------------------------

  /**
   * Walks the class prototype chain and returns every method that carries
   * `BATCH_STEP_METADATA`. Each entry's `isTasklet` is true when the same
   * method also carries `BATCH_TASKLET_METADATA`.
   *
   * Walks the full prototype chain (not just `Object.getOwnPropertyNames`
   * on the top-level prototype) so that inherited `@Stepable` methods are
   * also picked up.
   */
  private collectStepMethods(prototype: object): DiscoveredStep[] {
    const result: DiscoveredStep[] = [];
    for (const name of this.allMethodNames(prototype)) {
      const opts = Reflect.getMetadata(BATCH_STEP_METADATA, prototype, name) as
        | StepableOptions
        | undefined;
      if (!opts) continue;
      const isTasklet =
        Reflect.getMetadata(BATCH_TASKLET_METADATA, prototype, name) === true;
      result.push({ methodName: name, options: opts, isTasklet });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Listener methods
  // -------------------------------------------------------------------------

  /**
   * Walks the prototype chain and returns every method decorated with one
   * of the 7 listener kinds (job / step / chunk / item-read / item-process /
   * item-write / skip). The metadata shape is uniform — `{ kind, phase,
   * nonCritical? }` — because every listener decorator funnels through
   * the same internal `defineListener` helper.
   */
  private collectListenerMethods(prototype: object): DiscoveredListener[] {
    const result: DiscoveredListener[] = [];
    for (const name of this.allMethodNames(prototype)) {
      const opts = Reflect.getMetadata(BATCH_LISTENER_METADATA, prototype, name) as
        | { kind: ListenerKind; phase: ListenerPhase; nonCritical?: boolean }
        | undefined;
      if (!opts) continue;
      result.push({
        methodName: name,
        kind: opts.kind,
        phase: opts.phase,
        nonCritical: opts.nonCritical,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Transition methods
  // -------------------------------------------------------------------------

  /**
   * Walks the prototype chain and returns every method carrying
   * `BATCH_TRANSITION_METADATA` (written by the `@OnTransition` decorator
   * added in Task 31). Until Task 31 lands, this method simply returns
   * an empty array.
   *
   * `onStatus` is the *string name* of a `FlowExecutionStatus` value
   * (e.g. `'COMPLETED'`, `'FAILED'`, `'STOPPED'`). It is stored as a string
   * to avoid a circular import from `core/ir` → `core/status` and to keep
   * the metadata JSON-serializable.
   */
  private collectTransitionMethods(prototype: object): DiscoveredTransition[] {
    const result: DiscoveredTransition[] = [];
    for (const name of this.allMethodNames(prototype)) {
      const opts = Reflect.getMetadata(BATCH_TRANSITION_METADATA, prototype, name) as
        | { fromStep: string; onStatus: string; toStep: string | null }
        | undefined;
      if (!opts) continue;
      result.push({ methodName: name, ...opts });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Prototype walker
  // -------------------------------------------------------------------------

  /**
   * Returns every own method name (excluding `constructor`) on the given
   * prototype and all of its ancestors up to (but not including)
   * `Object.prototype`. Order is undefined, so callers that need a stable
   * order should sort afterwards.
   */
  private allMethodNames(prototype: object): Set<string> {
    const names = new Set<string>();
    let proto: object | null = prototype;
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        names.add(name);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return names;
  }
}
