import { JobBuilder } from './job-builder';

/**
 * Entry point for the fluent Builder API. A tiny, stateless
 * bootstrap object that hands out a fresh `JobBuilder` per `.job(id)` call.
 *
 *   const config = BatchBuilder.create()
 *     .job('nightly-import')
 *       .addStep((b) => b.chunk('read', 100, { reader, writer }))
 *       .from('read').on(COMPLETED).end()
 *       .build();
 *
 * The returned `JobBuilder` produces a plain-data `JobBuilderConfig`
 * (see `compiler/builder-types.ts`) which `DefinitionCompiler.compileFromBuilderConfig`
 * then converts to the same `JobDefinition` IR produced by the decorator path.
 */
export class BatchBuilder {
  private constructor() {}

  /** Create a new `BatchBuilder` root. */
  static create(): BatchBuilder {
    return new BatchBuilder();
  }

  /**
   * Start a new job. Each call returns a fresh, independent `JobBuilder`.
   * A single `BatchBuilder` can therefore be used to bootstrap many jobs.
   */
  job(id: string): JobBuilder {
    return JobBuilder.create(id);
  }
}
