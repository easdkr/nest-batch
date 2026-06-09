-- Migration: 0001 — 6-table Spring Batch-compatible meta-schema for PostgreSQL.
--
-- This file is the canonical raw-SQL DDL for the `@nest-batch/postgresql`
-- driver sibling. It is the source of truth for the meta-schema shape
-- and the column-type choices (PostgreSQL `timestamptz`, `text`,
-- `varchar(N)`, `int`). The 4 adapter slots (MikroORM, TypeORM, Drizzle,
-- Prisma) all use the column names defined here via the
-- *DriverProvider token binding.
--
-- The 5 tables (the classic 6 minus the dropped
-- `batch_step_execution_params`):
--
--   - batch_job_instance
--   - batch_job_execution
--   - batch_step_execution
--   - batch_job_execution_context
--   - batch_step_execution_context
--
-- The 6th table (`batch_step_execution_params`) is intentionally NOT
-- shipped. Step parameters are derivable from the parent job execution
-- params plus the step execution context. The active-execution unique
-- index is also intentionally NOT shipped: the
-- `SELECT ... FOR UPDATE SKIP LOCKED` pattern in
-- `createExecutionAtomic` provides the same guarantee without the
-- constraint's write-contention cost.
--
-- The `params` column on `batch_job_execution` is a JSON snapshot —
-- stored as `text` to keep the schema portable and always serialized
-- (never queried structurally).
--
-- This file is also consumed by the e2e harness as the canonical
-- DDL to apply against a fresh Postgres testcontainer.

CREATE TABLE IF NOT EXISTS "batch_job_instance" (
  "id"           VARCHAR(255) PRIMARY KEY,
  "job_name"     VARCHAR(255) NOT NULL,
  "job_key"      VARCHAR(255) NOT NULL,
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "batch_job_instance_job_name_job_key_unique" UNIQUE ("job_name", "job_key")
);

CREATE INDEX IF NOT EXISTS "batch_job_execution_job_instance_id_index"
  ON "batch_job_execution" ("job_instance_id");

CREATE TABLE IF NOT EXISTS "batch_job_execution" (
  "id"               VARCHAR(255) PRIMARY KEY,
  "job_instance_id"  VARCHAR(255) NOT NULL,
  "status"           VARCHAR(20)  NOT NULL,
  "start_time"       TIMESTAMPTZ,
  "end_time"         TIMESTAMPTZ,
  "exit_code"        VARCHAR(255) NOT NULL DEFAULT '',
  "exit_message"     TEXT         NOT NULL DEFAULT '',
  "params"           TEXT         NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS "batch_step_execution_job_execution_id_index"
  ON "batch_step_execution" ("job_execution_id");

CREATE TABLE IF NOT EXISTS "batch_step_execution" (
  "id"               VARCHAR(255) PRIMARY KEY,
  "job_execution_id" VARCHAR(255) NOT NULL,
  "step_name"        VARCHAR(255) NOT NULL,
  "status"           VARCHAR(20)  NOT NULL,
  "read_count"       INT          NOT NULL DEFAULT 0,
  "write_count"      INT          NOT NULL DEFAULT 0,
  "skip_count"       INT          NOT NULL DEFAULT 0,
  "rollback_count"   INT          NOT NULL DEFAULT 0,
  "commit_count"     INT          NOT NULL DEFAULT 0,
  "exit_code"        VARCHAR(255) NOT NULL DEFAULT '',
  "exit_message"     TEXT         NOT NULL DEFAULT '',
  "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "batch_job_execution_context" (
  "job_execution_id" VARCHAR(255) PRIMARY KEY,
  "data"             TEXT         NOT NULL,
  "version"          INT          NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "batch_step_execution_context" (
  "step_execution_id" VARCHAR(255) PRIMARY KEY,
  "data"              TEXT         NOT NULL,
  "version"           INT          NOT NULL DEFAULT 0
);
