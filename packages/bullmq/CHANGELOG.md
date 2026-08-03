# @nest-batch/bullmq

## 0.2.6

### Patch Changes

- 209418c: Prevent BullMQ schedules with `overlap: 'skip'` from creating a new execution while the previous scheduled execution is still active, without dropping volatile schedule parameters such as `scheduledAt`.
- Updated dependencies [209418c]
  - @nest-batch/core@0.2.7

## 0.2.5

### Patch Changes

- 8066dd9: Wait for the Redis connection to become ready before installing BullMQ job schedulers.

## 0.2.4

### Patch Changes

- dbeeaf6: Preserve shared BullMQ job schedulers when an application instance shuts down.

## 0.2.3

### Patch Changes

- 660f02e: Wait for Redis readiness before installing BullMQ job schedulers and record only successful registrations.

## 0.2.2

### Patch Changes

- Rewrite public README documentation around user-facing installation, wiring,
  and package responsibilities, and include Korean README files in published
  package tarballs.
- Updated dependencies
  - @nest-batch/core@0.2.4

## 0.2.1

### Patch Changes

- Ship decorator-first scheduling and listener runtime support.
- Updated dependencies
  - @nest-batch/core@0.2.1
