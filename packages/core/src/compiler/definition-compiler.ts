import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import {
  RefKind,
  type JobDefinition,
  type StepDefinition,
  type ChunkStepDefinition,
  type TaskletStepDefinition,
  type ReaderRef,
  type ProcessorRef,
  type WriterRef,
  type TaskletRef,
  type ListenerRef,
  type ListenerDefinition,
  type TransitionDefinition,
} from '../core/ir';
import { FlowExecutionStatus } from '../core/status';
import { BatchError, InvalidFlowGraphError } from '../core/errors';
import { DefinitionValidator } from '../core/validation/definition-validator';
import { validatePartitions, InvalidPartitionsError } from '../partition-helpers';
import type { DiscoveredJob } from '../explorer/batch-explorer';
import {
  BATCH_ITEM_READER_METADATA,
  BATCH_ITEM_PROCESSOR_METADATA,
  BATCH_ITEM_WRITER_METADATA,
} from '../decorators/constants';
import type { JobBuilderConfig } from './builder-types';

/**
 * Thrown when a chunk step on a discovered class cannot resolve a required
 * item handler method (`@ItemReader` or `@ItemWriter`) on the class prototype.
 *
 * Distinct from `InvalidFlowGraphError` because this is a *static* class-shape
 * problem (the class is missing a decorator), not a flow-graph problem
 * (transitions, start, reachability). The `code` is stable for callers
 * that want to switch on it.
 */
export class ProviderNotFoundError extends BatchError {
  readonly code = 'PROVIDER_NOT_FOUND';
  constructor(token: string) {
    super(`Provider not found: ${token}`, { token });
  }
}

/**
 * `DefinitionCompiler` is the bridge between metadata-rich sources
 * (decorator-discovered classes, fluent builder configs) and the
 * `JobDefinition` IR consumed by the rest of the runtime.
 *
 * Two compilation paths share the same output type:
 *
 *   - `compileFromDiscovered(discovered)` walks the class prototype
 *     (resolved by `BatchExplorer` in Task 7) and binds reader /
 *     processor / writer / tasklet / listener methods into `Ref`s.
 *   - `compileFromBuilderConfig(config)` accepts a plain-data config
 *     from the builder API and copies it into a `JobDefinition`.
 *
 * Both paths run the same `DefinitionValidator` before returning, so
 * downstream consumers can assume the IR is structurally sound.
 *
 * The compiler does NOT register the job — that is `JobRegistry`'s job
 * (Task 9). The compiler is pure: it produces IR, nothing else.
 */
@Injectable()
export class DefinitionCompiler {
  private readonly logger = new Logger(DefinitionCompiler.name);
  private readonly validator = new DefinitionValidator();

  /**
   * Compile from a discovered class. Resolves reader/processor/writer methods
   * on the class prototype and assembles StepDefinitions. Validates before returning.
   */
  compileFromDiscovered(discovered: DiscoveredJob): JobDefinition {
    const steps: Record<string, StepDefinition> = {};
    const startStepId = discovered.stepMethods[0]?.options.id ?? '';
    const classToken = discovered.classRef.name;

    for (const step of discovered.stepMethods) {
      if (step.isTasklet) {
        steps[step.options.id] = this.buildTaskletStep(discovered, classToken, step);
      } else {
        steps[step.options.id] = this.buildChunkStep(discovered, classToken, step);
      }
    }

    const listenerDefs: ListenerDefinition[] = discovered.listenerMethods.map((l) => ({
      kind: l.kind,
      phase: l.phase,
      nonCritical: l.nonCritical,
      ref: this.buildListenerRef(discovered, classToken, l.methodName),
    }));

    const transitions: TransitionDefinition[] = discovered.transitionMethods.map((t) => ({
      fromStepId: t.fromStep,
      onStatus:
        (FlowExecutionStatus as Record<string, FlowExecutionStatus>)[t.onStatus] ??
        FlowExecutionStatus.UNKNOWN,
      toStepId: t.toStep,
    }));

    const job: JobDefinition = {
      id: discovered.jobOptions.id,
      steps,
      startStepId,
      transitions,
      listeners: listenerDefs,
      restartable: discovered.jobOptions.restartable ?? false,
      allowDuplicateInstances: discovered.jobOptions.allowDuplicateInstances ?? false,
    };

    this.logger.log(
      `Compiled job "${job.id}" from "${classToken}": ${
        Object.keys(steps).length
      } step(s), ${listenerDefs.length} listener(s), ${transitions.length} transition(s)`,
    );

    this.validator.validate(job);
    return job;
  }

  /**
   * Compile from a builder config. Used by the fluent Builder API.
   * Same validation as `compileFromDiscovered`.
   */
  compileFromBuilderConfig(config: JobBuilderConfig): JobDefinition {
    const steps: Record<string, StepDefinition> = {};
    for (const s of config.steps) {
      steps[s.id] = s;
    }
    const job: JobDefinition = {
      id: config.id,
      steps,
      startStepId: config.startStepId,
      transitions: config.transitions,
      listeners: config.listeners,
      restartable: config.restartable,
      allowDuplicateInstances: config.allowDuplicateInstances,
    };
    this.validator.validate(job);
    return job;
  }

  // --- private helpers --------------------------------------------------

  /**
   * Resolve a listener method on a discovered class to a callable
   * `ListenerRef`. Mirrors the tasklet-ref resolution in
   * `buildTaskletStep`: if the DI container has already instantiated
   * the class (which is the case by the time the explorer walks
   * providers at `onModuleInit`), the method is pre-bound to the
   * instance and the returned ref is a `BuilderLambda` carrying the
   * bound function. This lets the runtime resolver map call the
   * listener directly without holding onto the instance or a
   * `ModuleRef`.
   *
   * When the instance is not yet available (factory providers that
   * have not been instantiated, late-bound providers, etc.) the ref
   * stays as a `Method` and the runtime resolver will throw a
   * deterministic error if it cannot resolve the class. The
   * pre-binding is a pure optimisation for the common
   * `providers: [MyClass]` case — the test suite exercises that path.
   */
  private buildListenerRef(
    discovered: DiscoveredJob,
    classToken: string,
    methodName: string,
  ): ListenerRef {
    const instance = discovered.instance as
      | Record<string, (...args: unknown[]) => unknown>
      | undefined;
    const method = instance?.[methodName];
    if (method) {
      return {
        kind: RefKind.BuilderLambda,
        fn: method.bind(discovered.instance) as (...args: any[]) => unknown,
      };
    }
    return { kind: RefKind.Method, classToken, methodName };
  }

  /**
   * Build a `TaskletStepDefinition` for a `@Stepable` + `@Tasklet` method.
   *
   * If a DI-resolved instance is available on the `DiscoveredJob`, the
   * tasklet ref is a `BuilderLambda` (bound function) so the executor
   * can call it directly. Otherwise we fall back to a `Method` ref that
   * the executor resolves at runtime against the DI container.
   */
  private buildTaskletStep(
    discovered: DiscoveredJob,
    classToken: string,
    step: DiscoveredJob['stepMethods'][number],
  ): TaskletStepDefinition {
    const instance = discovered.instance as
      | Record<string, (...args: unknown[]) => unknown>
      | undefined;
    const method = instance?.[step.methodName];
    const taskletRef: TaskletRef = method
      ? { kind: RefKind.BuilderLambda, fn: () => method.bind(discovered.instance) }
      : { kind: RefKind.Method, classToken, methodName: step.methodName };
    return {
      kind: 'tasklet',
      id: step.options.id,
      tasklet: taskletRef,
      listeners: [],
    };
  }

  /**
   * Build a `ChunkStepDefinition` for a `@Stepable` (no `@Tasklet`) method.
   * Requires `@ItemReader` and `@ItemWriter` on the class; `@ItemProcessor`
   * is optional.
   *
   * Throws `ProviderNotFoundError` if a required handler is missing.
   */
  private buildChunkStep(
    discovered: DiscoveredJob,
    classToken: string,
    step: DiscoveredJob['stepMethods'][number],
  ): ChunkStepDefinition {
    const reader = this.findItemMethod(discovered, BATCH_ITEM_READER_METADATA);
    const processor = this.findItemMethod(discovered, BATCH_ITEM_PROCESSOR_METADATA);
    const writer = this.findItemMethod(discovered, BATCH_ITEM_WRITER_METADATA);

    if (!reader) {
      throw new ProviderNotFoundError(
        `@ItemReader for job ${discovered.jobOptions.id} (step ${step.options.id})`,
      );
    }
    if (!writer) {
      throw new ProviderNotFoundError(
        `@ItemWriter for job ${discovered.jobOptions.id} (step ${step.options.id})`,
      );
    }

    const readerRef: ReaderRef = this.buildItemMethodRef(discovered, classToken, reader);
    const writerRef: WriterRef = this.buildItemMethodRef(discovered, classToken, writer);

    // Validate the partition config at compile time so a typo
    // (e.g. `count: 0`) fails at module load rather than at
    // runtime when the launcher pre-creates the execution.
    // `DefinitionValidator.validate` does the same check later
    // (the IR is the source of truth), but the compiler is the
    // first place we have the value in hand and we want the
    // earliest possible failure for a decorator-discovered job.
    try {
      validatePartitions(step.options.partitions);
    } catch (err) {
      if (err instanceof InvalidPartitionsError) {
        throw new InvalidFlowGraphError(
          'INVALID_PARTITIONS',
          `Step "${step.options.id}" has invalid partitions: ${err.message}`,
          { jobId: discovered.jobOptions.id, stepId: step.options.id, partitions: step.options.partitions },
        );
      }
      throw err;
    }

    return {
      kind: 'chunk',
      id: step.options.id,
      chunkSize: step.options.chunkSize ?? 100,
      reader: readerRef,
      writer: writerRef,
      skipPolicy: step.options.skipPolicy,
      retryPolicy: step.options.retryPolicy,
      listeners: [],
      ...(step.options.partitions !== undefined
        ? { partitions: step.options.partitions }
        : {}),
      ...(processor
        ? {
            processor: this.buildItemMethodRef(discovered, classToken, processor) satisfies ProcessorRef,
          }
        : {}),
    };
  }

  private buildItemMethodRef(
    discovered: DiscoveredJob,
    classToken: string,
    methodName: string,
  ): ReaderRef | ProcessorRef | WriterRef {
    const instance = discovered.instance as
      | Record<string, (...args: unknown[]) => unknown>
      | undefined;
    const method = instance?.[methodName];
    if (method) {
      return {
        kind: RefKind.BuilderLambda,
        fn: () => method.bind(discovered.instance),
      };
    }
    return {
      kind: RefKind.Method,
      classToken,
      methodName,
    };
  }

  /**
   * Walks the prototype chain (including inherited prototypes, stopping
   * at `Object.prototype`) looking for a method carrying the given
   * `BATCH_ITEM_*` metadata key.
   *
   * Returns the method name or `undefined`. The explorer only records
   * `@Stepable` / listener / transition methods; item handlers are
   * resolved here at compile time.
   */
  private findItemMethod(discovered: DiscoveredJob, metadataKey: string): string | undefined {
    const proto = discovered.classRef.prototype as object | undefined;
    if (!proto) return undefined;
    let p: object | null = proto;
    while (p && p !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(p)) {
        if (name === 'constructor') continue;
        if (Reflect.getMetadata(metadataKey, p, name) === true) return name;
      }
      p = Object.getPrototypeOf(p);
    }
    return undefined;
  }
}
