---
'@nest-batch/core': patch
---

Add reader checkpoint support for chunk steps. `@ItemReader({ factory: true })` now marks a factory-mode reader that is invoked once at step start and returns an `ItemReader` (optionally implementing `ItemStream`), enabling resumable readers that persist and restore their position across restarts. Default (per-read) `@ItemReader()` usage is unchanged.
