import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  JobRepository,
  JobExecutionAlreadyRunningError,
  assertJsonSerializable,
  serializeContext,
  deserializeContext,
  JobStatus,
  StepStatus,
} from '@nest-batch/core';
import type {
  JobInstance,
  JobExecution,
  JobExecutionPatch,
  JobParameters,
  StepExecution,
  StepExecutionPatch,
  ExecutionContext,
  ExecutionScope,
} from '@nest-batch/core';
import { eq, inArray, and, desc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle-schema.postgres';

function scopeKey(scope: ExecutionScope): string {
  if ('jobExecutionId' in scope) return `job::${scope.jobExecutionId}`;
  return `step::${scope.stepExecutionId}`;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return deepClone(value) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = deepClone((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

function mapJobInstance(
  e: typeof schema.batchJobInstance.$inferSelect,
): JobInstance {
  return {
    id: e.id,
    jobName: e.jobName,
    jobKey: e.jobKey,
    createdAt: e.createdAt,
  };
}

function mapJobExecution(
  e: typeof schema.batchJobExecution.$inferSelect,
): JobExecution {
  let params: JobParameters = {};
  if (e.params && e.params.length > 0) {
    try {
      params = deserializeContext<JobParameters>(e.params);
    } catch {
      params = {};
    }
  }
  return {
    id: e.id,
    jobInstanceId: e.jobInstanceId,
    status: e.status as JobStatus,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    exitCode: e.exitCode,
    exitMessage: e.exitMessage,
    params,
  };
}

function mapStepExecution(
  e: typeof schema.batchStepExecution.$inferSelect,
): StepExecution {
  return {
    id: e.id,
    jobExecutionId: e.jobExecutionId,
    stepName: e.stepName,
    status: e.status as StepStatus,
    readCount: e.readCount,
    writeCount: e.writeCount,
    skipCount: e.skipCount,
    rollbackCount: e.rollbackCount,
    commitCount: e.commitCount,
    startTime: null,
    endTime: null,
    exitCode: e.exitCode,
    exitMessage: e.exitMessage,
  };
}

/**
 * PostgreSQL-flavored Drizzle ORM `JobRepository`.
 *
 * Mirrors the MySQL `MysqlDrizzleJobRepository` in `@nest-batch/mysql`
 * exactly: same column names, same contract invariants. The
 * dialect-specific differences are:
 *
 *   1. Schema source: `drizzle-schema.postgres.ts` (this package)
 *      instead of `mysql-drizzle/schema.ts` (mysql package).
 *   2. DB typing: `NodePgDatabase<typeof schema>` from
 *      `drizzle-orm/node-postgres` instead of
 *      `MySql2Database<typeof schema>` from `drizzle-orm/mysql2`.
 *   3. Identifier quoting: backticks → double quotes in raw SQL.
 *   4. Upsert idiom: `ON DUPLICATE KEY UPDATE id=id` (MySQL) →
 *      `ON CONFLICT (job_name, job_key) DO NOTHING` (Postgres).
 *   5. Datetime literal: `NOW(6)` → `NOW()`.
 */
@Injectable()
export class PostgresDrizzleJobRepository extends JobRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {
    super();
  }

  async getOrCreateJobInstance(name: string, jobKey: string): Promise<JobInstance> {
    const existing = await this.db
      .select()
      .from(schema.batchJobInstance)
      .where(
        and(
          eq(schema.batchJobInstance.jobName, name),
          eq(schema.batchJobInstance.jobKey, jobKey),
        ),
      )
      .limit(1);
    if (existing.length > 0) return mapJobInstance(existing[0]!);

    const id = randomUUID();
    try {
      await this.db.insert(schema.batchJobInstance).values({
        id,
        jobName: name,
        jobKey,
        createdAt: new Date(),
      });
      return { id, jobName: name, jobKey, createdAt: new Date() };
    } catch {
      const winner = await this.db
        .select()
        .from(schema.batchJobInstance)
        .where(
          and(
            eq(schema.batchJobInstance.jobName, name),
            eq(schema.batchJobInstance.jobKey, jobKey),
          ),
        )
        .limit(1);
      if (winner.length > 0) return mapJobInstance(winner[0]!);
      throw new Error(
        `Failed to upsert JobInstance (${name}, ${jobKey}) and could not read it back`,
      );
    }
  }

  async createJobExecution(
    jobInstanceId: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    const exec = {
      id: randomUUID(),
      jobInstanceId,
      status: JobStatus.STARTING,
      startTime: null,
      endTime: null,
      exitCode: '',
      exitMessage: '',
      params: serializeContext(deepClone(params)),
    };
    await this.db.insert(schema.batchJobExecution).values(exec);
    return mapJobExecution(exec as typeof schema.batchJobExecution.$inferSelect);
  }

  async createExecutionAtomic(
    name: string,
    jobKey: string,
    params: JobParameters,
  ): Promise<JobExecution> {
    return this.db.transaction(async (tx) => {
      // 1. Idempotently insert the JobInstance row.
      //    Postgres `ON CONFLICT (job_name, job_key) DO NOTHING`
      //    is the dialect equivalent of MySQL's
      //    `INSERT ... ON DUPLICATE KEY UPDATE id=id`. The follow-up
      //    SELECT (under the row lock) finds the row whether the
      //    insert actually inserted or the conflict fired.
      const instId = randomUUID();
      await tx.execute(
        sql`INSERT INTO "batch_job_instance" ("id", "job_name", "job_key", "created_at")
            VALUES (${instId}, ${name}, ${jobKey}, NOW())
            ON CONFLICT ("job_name", "job_key") DO NOTHING`,
      );

      // 2. Lock the instance row with SKIP LOCKED. Postgres 9.5+
      // supports `FOR UPDATE SKIP LOCKED` natively.
      const locked = await tx.execute(
        sql`SELECT "id", "job_name", "job_key", "created_at"
            FROM "batch_job_instance"
            WHERE "job_name" = ${name} AND "job_key" = ${jobKey}
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
      );
      const lockedRows = (Array.isArray(locked)
        ? (locked as Array<{ id: string }>)
        : ((locked as unknown as { rows: Array<{ id: string }> }).rows ?? []));
      if (lockedRows.length === 0) {
        throw new JobExecutionAlreadyRunningError(name);
      }
      const instanceId = lockedRows[0]!.id;

      // 3. Under the lock, verify no running execution.
      const running = await tx
        .select()
        .from(schema.batchJobExecution)
        .where(
          and(
            eq(schema.batchJobExecution.jobInstanceId, instanceId),
            inArray(schema.batchJobExecution.status, [
              JobStatus.STARTING,
              JobStatus.STARTED,
            ]),
          ),
        )
        .limit(1);
      if (running.length > 0) {
        throw new JobExecutionAlreadyRunningError(running[0]!.id);
      }

      // 4. Create the new execution row.
      const exec = {
        id: randomUUID(),
        jobInstanceId: instanceId,
        status: JobStatus.STARTING,
        startTime: null,
        endTime: null,
        exitCode: '',
        exitMessage: '',
        params: serializeContext(deepClone(params)),
      };
      await tx.insert(schema.batchJobExecution).values(exec);
      return mapJobExecution(exec as typeof schema.batchJobExecution.$inferSelect);
    });
  }

  async updateJobExecution(executionId: string, patch: JobExecutionPatch): Promise<void> {
    const data: Partial<typeof schema.batchJobExecution.$inferInsert> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.startTime !== undefined) data.startTime = patch.startTime;
    if (patch.endTime !== undefined) data.endTime = patch.endTime;
    if (patch.exitCode !== undefined) data.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) data.exitMessage = patch.exitMessage;
    await this.db
      .update(schema.batchJobExecution)
      .set(data)
      .where(eq(schema.batchJobExecution.id, executionId));
  }

  async getJobExecution(executionId: string): Promise<JobExecution | null> {
    const rows = await this.db
      .select()
      .from(schema.batchJobExecution)
      .where(eq(schema.batchJobExecution.id, executionId))
      .limit(1);
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async getRunningJobExecution(jobInstanceId: string): Promise<JobExecution | null> {
    if (!jobInstanceId) return null;
    const rows = await this.db
      .select()
      .from(schema.batchJobExecution)
      .where(
        and(
          eq(schema.batchJobExecution.jobInstanceId, jobInstanceId),
          inArray(schema.batchJobExecution.status, [
            JobStatus.STARTING,
            JobStatus.STARTED,
          ]),
        ),
      )
      .orderBy(desc(schema.batchJobExecution.startTime))
      .limit(1);
    return rows.length > 0 ? mapJobExecution(rows[0]!) : null;
  }

  async createStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution> {
    const step = {
      id: randomUUID(),
      jobExecutionId,
      stepName,
      status: StepStatus.STARTING,
      readCount: 0,
      writeCount: 0,
      skipCount: 0,
      rollbackCount: 0,
      commitCount: 0,
      exitCode: '',
      exitMessage: '',
      createdAt: new Date(),
    };
    await this.db.insert(schema.batchStepExecution).values(step);
    return mapStepExecution(step as typeof schema.batchStepExecution.$inferSelect);
  }

  async updateStepExecution(
    stepExecutionId: string,
    patch: StepExecutionPatch,
  ): Promise<void> {
    const data: Partial<typeof schema.batchStepExecution.$inferInsert> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.readCount !== undefined) data.readCount = patch.readCount;
    if (patch.writeCount !== undefined) data.writeCount = patch.writeCount;
    if (patch.skipCount !== undefined) data.skipCount = patch.skipCount;
    if (patch.rollbackCount !== undefined) data.rollbackCount = patch.rollbackCount;
    if (patch.commitCount !== undefined) data.commitCount = patch.commitCount;
    if (patch.exitCode !== undefined) data.exitCode = patch.exitCode;
    if (patch.exitMessage !== undefined) data.exitMessage = patch.exitMessage;
    await this.db
      .update(schema.batchStepExecution)
      .set(data)
      .where(eq(schema.batchStepExecution.id, stepExecutionId));
  }

  async getStepExecution(stepExecutionId: string): Promise<StepExecution | null> {
    const rows = await this.db
      .select()
      .from(schema.batchStepExecution)
      .where(eq(schema.batchStepExecution.id, stepExecutionId))
      .limit(1);
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  /**
   * Postgres has no `ctid` reliable for ordered lookup across
   * separate sessions; the contract suite relies on
   * "most-recently-created wins" semantics. Order by
   * `created_at DESC, id DESC` (the `createdAt` column is set to
   * `defaultNow()` on insert, matching the mysql shell's
   * behavior).
   */
  async findLatestStepExecution(
    jobExecutionId: string,
    stepName: string,
  ): Promise<StepExecution | null> {
    const rows = await this.db
      .select()
      .from(schema.batchStepExecution)
      .where(
        and(
          eq(schema.batchStepExecution.jobExecutionId, jobExecutionId),
          eq(schema.batchStepExecution.stepName, stepName),
        ),
      )
      .orderBy(
        desc(schema.batchStepExecution.createdAt),
        desc(schema.batchStepExecution.id),
      )
      .limit(1);
    return rows.length > 0 ? mapStepExecution(rows[0]!) : null;
  }

  async getExecutionContext(scope: ExecutionScope): Promise<ExecutionContext> {
    const key = scopeKey(scope);
    if (key.startsWith('job::')) {
      const rows = await this.db
        .select()
        .from(schema.batchJobExecutionContext)
        .where(eq(schema.batchJobExecutionContext.jobExecutionId, key.slice(5)))
        .limit(1);
      if (rows.length > 0) {
        const e = rows[0]!;
        return {
          data: e.data.length > 0 ? deserializeContext(e.data) : null,
          version: e.version,
        };
      }
    } else {
      const rows = await this.db
        .select()
        .from(schema.batchStepExecutionContext)
        .where(eq(schema.batchStepExecutionContext.stepExecutionId, key.slice(6)))
        .limit(1);
      if (rows.length > 0) {
        const e = rows[0]!;
        return {
          data: e.data.length > 0 ? deserializeContext(e.data) : null,
          version: e.version,
        };
      }
    }
    return { data: null, version: 0 };
  }

  async saveExecutionContext(
    scope: ExecutionScope,
    ctx: ExecutionContext,
    version?: number,
  ): Promise<void> {
    assertJsonSerializable(ctx.data);
    const key = scopeKey(scope);
    const serialized = serializeContext(deepClone(ctx.data));
    if (key.startsWith('job::')) {
      const jobExecutionId = key.slice(5);
      const existing = await this.db
        .select()
        .from(schema.batchJobExecutionContext)
        .where(eq(schema.batchJobExecutionContext.jobExecutionId, jobExecutionId))
        .limit(1);
      const nextVersion = version !== undefined ? version : (existing[0]?.version ?? 0) + 1;
      if (existing.length > 0) {
        await this.db
          .update(schema.batchJobExecutionContext)
          .set({ data: serialized, version: nextVersion })
          .where(eq(schema.batchJobExecutionContext.jobExecutionId, jobExecutionId));
      } else {
        await this.db.insert(schema.batchJobExecutionContext).values({
          jobExecutionId,
          data: serialized,
          version: nextVersion,
        });
      }
    } else {
      const stepExecutionId = key.slice(6);
      const existing = await this.db
        .select()
        .from(schema.batchStepExecutionContext)
        .where(eq(schema.batchStepExecutionContext.stepExecutionId, stepExecutionId))
        .limit(1);
      const nextVersion = version !== undefined ? version : (existing[0]?.version ?? 0) + 1;
      if (existing.length > 0) {
        await this.db
          .update(schema.batchStepExecutionContext)
          .set({ data: serialized, version: nextVersion })
          .where(eq(schema.batchStepExecutionContext.stepExecutionId, stepExecutionId));
      } else {
        await this.db.insert(schema.batchStepExecutionContext).values({
          stepExecutionId,
          data: serialized,
          version: nextVersion,
        });
      }
    }
  }
}
