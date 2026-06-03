import type {
  StepDefinition,
  ChunkStepDefinition,
  TaskletStepDefinition,
  ReaderRef,
  ProcessorRef,
  WriterRef,
  TaskletRef,
  ListenerRef,
  ItemListenerRef,
  SkipPolicyConfig,
  RetryPolicyConfig,
  ListenerDefinition,
  ListenerKind,
  ListenerPhase,
} from '../core/ir';

/**
 * Fluent builder for a single step (`chunk` or `tasklet`).
 *
 * Typical usage via `JobBuilder.addStep` callback:
 *
 *   .addStep((b) => b
 *     .chunk('read-csv', 100, {
 *       reader: { kind: BuilderLambda, fn: readCsv },
 *       processor: { kind: BuilderLambda, fn: transform },
 *       writer: { kind: BuilderLambda, fn: writeRows },
 *     }))
 *
 *   .addStep((b) => b
 *     .tasklet('cleanup', { kind: BuilderLambda, fn: cleanup }))
 *
 * The builder is single-use: call `.build()` once to produce the
 * `StepDefinition` IR.
 */
export class StepBuilder {
  // Field names use a `_` prefix to avoid colliding with the same-named
  // setter methods (`reader` / `processor` / `writer` / `tasklet` /
  // `skipPolicy` / `retryPolicy`). With `useDefineForClassFields: false`
  // (project tsconfig), a class field shadows any prototype method of
  // the same name — which would make the fluent setters unreachable and
  // (more subtly) make `if (this.tasklet)` in `build()` accidentally
  // find the method via the prototype chain.
  private _chunkSize?: number;
  private _reader?: ReaderRef;
  private _processor?: ProcessorRef;
  private _writer?: WriterRef;
  private _tasklet?: TaskletRef;
  private _id?: string;
  private _skipPolicy?: SkipPolicyConfig;
  private _retryPolicy?: RetryPolicyConfig;
  private readonly itemListeners: ItemListenerRef[] = [];
  private readonly listenerDefs: ListenerDefinition[] = [];

  // --- step-kind entry points ------------------------------------------

  /**
   * Start a chunk step. Sets the step id and chunk size; optionally
   * accepts reader/processor/writer/policies in a single call.
   *
   *   .chunk('s1', 100, { reader, processor, writer })
   *   .chunk('s2', 50,  { reader, writer, skipPolicy })
   *
   * Throws if `size` is not a positive integer.
   */
  chunk(
    id: string,
    size: number,
    config?: {
      reader: ReaderRef;
      processor?: ProcessorRef;
      writer: WriterRef;
      skipPolicy?: SkipPolicyConfig;
      retryPolicy?: RetryPolicyConfig;
    },
  ): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error('chunkSize must be a positive integer');
    }
    this._id = id;
    this._chunkSize = size;
    if (config) {
      this._reader = config.reader;
      this._processor = config.processor;
      this._writer = config.writer;
      this._skipPolicy = config.skipPolicy;
      this._retryPolicy = config.retryPolicy;
    }
    return this;
  }

  /**
   * Start a tasklet step. Sets the step id and the tasklet ref.
   *
   *   .tasklet('cleanup', { kind: BuilderLambda, fn: cleanup })
   */
  tasklet(id: string, ref: TaskletRef): this {
    this._id = id;
    this._tasklet = ref;
    return this;
  }

  // --- fine-grained setters (used after `.chunk(id, size)`) -----------

  reader(ref: ReaderRef): this {
    this._reader = ref;
    return this;
  }

  processor(ref: ProcessorRef): this {
    this._processor = ref;
    return this;
  }

  writer(ref: WriterRef): this {
    this._writer = ref;
    return this;
  }

  skipPolicy(p: SkipPolicyConfig): this {
    this._skipPolicy = p;
    return this;
  }

  retryPolicy(p: RetryPolicyConfig): this {
    this._retryPolicy = p;
    return this;
  }

  /**
   * Attach an item-level listener ref to this step. Listener metadata
   * is also recorded internally so it can be re-emitted via `.build()`.
   *
   * (The step IR's `listeners: ItemListenerRef[]` field is the source of
   * truth at runtime; the `ListenerDefinition[]` aggregate lives on the
   * job. We keep both in sync here for downstream consumer convenience.)
   */
  addListener(
    ref: ListenerRef,
    kind: ListenerKind,
    phase: ListenerPhase,
    nonCritical?: boolean,
  ): this {
    this.itemListeners.push(ref);
    this.listenerDefs.push({
      ref,
      kind,
      phase,
      ...(nonCritical !== undefined ? { nonCritical } : {}),
    });
    return this;
  }

  // --- build -----------------------------------------------------------

  /**
   * Produce the `StepDefinition` IR. Throws if the step is missing an
   * id, or is neither a configured tasklet nor a configured chunk
   * (chunk requires both `reader` and `writer`).
   */
  build(): StepDefinition {
    if (!this._id) {
      throw new Error('Step must have an id (call .chunk() or .tasklet() first)');
    }
    if (this._tasklet) {
      const def: TaskletStepDefinition = {
        kind: 'tasklet',
        id: this._id,
        tasklet: this._tasklet,
        listeners: this.itemListeners,
      };
      return def;
    }
    if (this._chunkSize !== undefined && this._reader && this._writer) {
      const def: ChunkStepDefinition = {
        kind: 'chunk',
        id: this._id,
        chunkSize: this._chunkSize,
        reader: this._reader,
        writer: this._writer,
        listeners: this.itemListeners,
        ...(this._processor ? { processor: this._processor } : {}),
        ...(this._skipPolicy ? { skipPolicy: this._skipPolicy } : {}),
        ...(this._retryPolicy ? { retryPolicy: this._retryPolicy } : {}),
      };
      return def;
    }
    throw new Error('Step must be either tasklet or chunk with reader+writer');
  }
}
