/**
 * Public surface for the `adapters/` package directory.
 *
 * Re-exports the in-process transport adapter so consumers can
 * import it via `@nest-batch/core` (the root barrel pulls this file
 * in) without having to know the internal directory layout.
 *
 * Future sibling adapters that *live inside* core (none are planned
 * at the moment) would be re-exported from here too. The persistence
 * and remote-transport adapters live in their own sibling packages
 * (`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/bullmq`,
 * ...) — those are not re-exported from this barrel because the
 * whole point of splitting the engine into sibling packages is to
 * keep the dependency graph one-way (core never depends on an
 * adapter package).
 */
export * from './in-process.adapter';
