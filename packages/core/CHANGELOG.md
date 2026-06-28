# @nest-batch/core

## 0.2.5

### Patch Changes

- 0388069: Add reader checkpoint support for chunk steps. `@ItemReader({ factory: true })` now marks a factory-mode reader that is invoked once at step start and returns an `ItemReader` (optionally implementing `ItemStream`), enabling resumable readers that persist and restore their position across restarts. Default (per-read) `@ItemReader()` usage is unchanged.

## 0.2.4

### Patch Changes

- Rewrite public README documentation around user-facing installation, wiring,
  and package responsibilities, and include Korean README files in published
  package tarballs.

## 0.2.3

### Patch Changes

- Add the `Batch` decorator namespace as the preferred public API while keeping `BatchDecorators` as a compatibility alias.

## 0.2.2

### Patch Changes

- Remove public runnable migration artifacts and document app-owned migration ownership.

## 0.2.1

### Patch Changes

- Ship decorator-first scheduling and listener runtime support.
