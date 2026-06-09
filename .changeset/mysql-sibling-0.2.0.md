---
'@nest-batch/mysql': minor
---

Scaffold the new `@nest-batch/mysql` sibling package for 0.2.0.
Adds 4 MySQL adapter shells (`MysqlMikroOrmAdapter`,
`MysqlTypeOrmAdapter`, `MysqlDrizzleAdapter`, `MysqlPrismaAdapter`),
each with the matching `MysqlXxxJobRepository`,
`MysqlXxxTransactionManager`, and `MysqlXxxBatchModule` classes. The
shells pair the driver-agnostic adapter slots in
`@nest-batch/mikro-orm`, `@nest-batch/typeorm`, `@nest-batch/drizzle`,
and `@nest-batch/prisma` with MySQL driver bindings
(`@mikro-orm/mysql`, `mysql2`, `drizzle-orm/mysql2`, `prisma`). Also
ships the 6-table MySQL DDL migration
(`CreateBatchMetaMysql1700000000001`) and the bundled
`prisma/schema.prisma` (mysql provider) for the Prisma shell. The
T-AC-2 final-form boundary test
(`packages/mysql/tests/boundary/no-forbidden-imports.test.ts`) scans
the 8 non-MySQL packages and asserts no MySQL driver leakage, and
the e2e harness
(`packages/mysql/tests/e2e-mysql.test.ts`) runs the
`@nest-batch/core` contract suite against a real MySQL 8.x
testcontainer (gated by `RUN_MYSQL_E2E=1`).
