---
'@nest-batch/prisma': minor
---

Stabilize the Prisma adapter for 0.2.0. Adds the per-package README
(install, peer-dep table, driver-pairing notice, wiring snippet, contract
test invocation, "What is NOT in this package" callout) and a
`tests/e2e-postgres.test.ts` harness that runs `prisma migrate deploy`
against the bundled schema in a real Postgres testcontainer and
re-executes the `@nest-batch/core` contract suite against the migrated
database, gated by `RUN_PRISMA_E2E=1`. No source changes; the source
refactor (Postgres `prisma/schema.prisma` provider extraction into
`@nest-batch/postgresql`) ships in the T10a follow-up changeset.
