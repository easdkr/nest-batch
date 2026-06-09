---
'@nest-batch/drizzle': minor
---

Stabilize the Drizzle ORM adapter for 0.2.0. Adds the per-package README
(install, peer-dep table, driver-pairing notice, wiring snippet, contract
test invocation, "What is NOT in this package" callout) and a
`tests/e2e-postgres.test.ts` harness that runs the
`@nest-batch/core` contract suite against a real Postgres testcontainer,
gated by `RUN_DRIZZLE_E2E=1`. No source changes; the source refactor
(Postgres shell extraction into `@nest-batch/postgresql`) ships in
the lockstep T15 changeset later.
