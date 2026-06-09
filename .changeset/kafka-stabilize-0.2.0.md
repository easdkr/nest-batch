---
'@nest-batch/kafka': minor
---

Stabilize the Kafka transport adapter for 0.2.0:

- **README.** Add `packages/kafka/README.md` with the per-package
  contract: install, peer-dep table
  (`@nest-batch/core@workspace:*`,
  `@nestjs/common@^10 || ^11`, `@nestjs/core@^10 || ^11`,
  `kafkajs@^2.2.4`), wiring with `KafkaAdapter.forRoot({ connection, ... })`,
  contract-test invocation, "What is NOT in this package" callout,
  and Scripts section.
- **Cron-parser limitation.** Document the hand-rolled
  `*/N * * * *` parser in
  `packages/kafka/src/kafka-schedule.service.ts:228-250` as a
  known 0.2.0 limitation. Only the 5-field `*/N * * * *` shape is
  supported; richer Quartz / Spring Batch cron syntax ships in
  0.3.0. The hand-rolled parser is intentionally not swapped
  out for `croner` / `cron-parser` — the limitation is locked
  and tracked for 0.3.0.
- **End-to-end test.** Add `packages/kafka/tests/e2e.test.ts`,
  gated by `RUN_KAFKA_E2E=1`. The suite launches a single-step
  job end-to-end against a real Kafka broker, asserts the
  producer returns a non-empty offset, the consumer picks the
  message up, and the canonical `JobExecution` row transitions
  to `COMPLETED`. Reuses `tests/kafka-e2e.config.ts` for the
  fixture builders and the reachability gate.

The Kafka source files (`src/`) are unchanged in this release —
the partition refactor lands in 0.3.0.
