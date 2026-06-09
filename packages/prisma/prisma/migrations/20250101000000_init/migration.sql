-- CreateTable
CREATE TABLE IF NOT EXISTS "batch_job_instance" (
    "id" VARCHAR(255) NOT NULL,
    "job_name" VARCHAR(255) NOT NULL,
    "job_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_job_instance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "batch_job_instance_job_name_job_key_unique" ON "batch_job_instance"("job_name", "job_key");

-- CreateTable
CREATE TABLE IF NOT EXISTS "batch_job_execution" (
    "id" VARCHAR(255) NOT NULL,
    "job_instance_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "start_time" TIMESTAMPTZ(6),
    "end_time" TIMESTAMPTZ(6),
    "exit_code" VARCHAR(255) NOT NULL DEFAULT '',
    "exit_message" TEXT NOT NULL DEFAULT '',
    "params" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "batch_job_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "batch_job_execution_job_instance_id_index" ON "batch_job_execution"("job_instance_id");

-- CreateTable
CREATE TABLE IF NOT EXISTS "batch_step_execution" (
    "id" VARCHAR(255) NOT NULL,
    "job_execution_id" VARCHAR(255) NOT NULL,
    "step_name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "write_count" INTEGER NOT NULL DEFAULT 0,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "rollback_count" INTEGER NOT NULL DEFAULT 0,
    "commit_count" INTEGER NOT NULL DEFAULT 0,
    "exit_code" VARCHAR(255) NOT NULL DEFAULT '',
    "exit_message" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_step_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "batch_step_execution_job_execution_id_index" ON "batch_step_execution"("job_execution_id");

-- CreateTable
CREATE TABLE IF NOT EXISTS "batch_job_execution_context" (
    "job_execution_id" VARCHAR(255) NOT NULL,
    "data" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "batch_job_execution_context_pkey" PRIMARY KEY ("job_execution_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "batch_step_execution_context" (
    "step_execution_id" VARCHAR(255) NOT NULL,
    "data" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "batch_step_execution_context_pkey" PRIMARY KEY ("step_execution_id")
);
