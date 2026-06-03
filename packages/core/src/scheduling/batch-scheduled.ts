import 'reflect-metadata';
import { SetMetadata } from '@nestjs/common';

import { BATCH_SCHEDULED_OPTIONS as SCHEDULED_KEY } from '../decorators/constants';

export const BATCH_SCHEDULED_OPTIONS = SCHEDULED_KEY;

/**
 * Spring Batch-like overlap policies for cron-scheduled jobs:
 *
 * - `'skip'`     — drop the new tick if the previous run is still in flight.
 * - `'queue'`    — buffer the new tick and start it after the current one ends.
 * - `'parallel'` — start the new tick alongside the current one.
 *
 * The runtime scheduler (the future `@nest-batch/bullmq` cron strategy)
 * reads this value off the stored metadata and applies the policy at
 * dispatch time. The decorator itself MUST NOT silently default the
 * policy to `'skip'` on the user's behalf — leaving it `undefined` here
 * is the contract: the runtime applies the default.
 */
export type BatchOverlapPolicy = 'skip' | 'queue' | 'parallel';

/**
 * Decorator-facing options for `@BatchScheduled`.
 *
 * - `name`     — required, unique per job (used as the scheduling key).
 * - `timezone` — required, IANA zone (e.g. `'UTC'`, `'Asia/Seoul'`).
 * - `overlap`  — optional, see `BatchOverlapPolicy`. Default applied at
 *                runtime, never silently here.
 * - `startAt`  — optional, absolute lower bound. Preserved by reference.
 * - `endAt`    — optional, absolute upper bound. Preserved by reference.
 * - `inert`    — optional, hints the runtime scheduler to skip actual
 *                registration. The decorator stamps this by reading
 *                `process.env.BATCH_SCHEDULED_DISABLE` at decoration time
 *                so the runtime never has to re-evaluate the env.
 */
export interface BatchScheduledOptions {
  name: string;
  timezone: string;
  overlap?: BatchOverlapPolicy;
  startAt?: Date;
  endAt?: Date;
  inert?: boolean;
}

/**
 * The shape stored under the `BATCH_SCHEDULED_OPTIONS` metadata key on
 * the decorated method function. The runtime scheduler (the future
 * `@nest-batch/bullmq` cron strategy) reads this verbatim to register
 * the job with the underlying scheduler.
 *
 * Note: `inert` lives at the top level (not inside `options`) on
 * purpose. It is a *runtime* flag captured at decoration time from
 * `process.env.BATCH_SCHEDULED_DISABLE`; it is not a user-facing
 * knob in `BatchScheduledOptions`. (The `inert?: boolean` slot on
 * `BatchScheduledOptions` is the user-facing counterpart — see the
 * GREEN half of Task 13 to wire it up.)
 */
export interface BatchScheduledMetadata {
  cron: string;
  options: BatchScheduledOptions;
  inert: boolean;
}

/**
 * `@BatchScheduled` — Spring Batch-like cron decorator.
 *
 * Stamps `BATCH_SCHEDULED_OPTIONS` metadata onto the decorated method's
 * function reference (via `@nestjs/common`'s `SetMetadata`, which writes
 * to `descriptor.value`), so `Reflect.getMetadata(KEY, Job.prototype.run)`
 * returns the stored shape.
 *
 * This is the TDD-RED half of Task 13. It deliberately implements only
 * the metadata-storing contract — i.e. the 10 happy-path assertions in
 * `tests/scheduling/batch-scheduled.test.ts` (sections A + B). The
 * 7 negative-path assertions in sections C + D are the GREEN half
 * of the contract and land in the next task:
 *
 *   1. Cron expression shape validation (5/6 fields, no literal words).
 *   2. IANA timezone validation (rejects unknown / empty / whitespace).
 *
 * The inert-mode flag (section E) is wired up here because it is also
 * a pure metadata capture — `process.env.BATCH_SCHEDULED_DISABLE` is
 * read at decoration time and stamped onto the stored shape. The
 * decorator does NOT install any timer, interval, or scheduler
 * registration at decoration time; `inert` is a hint the future
 * runtime scheduler honors when it later walks the class.
 *
 * The decorator is metadata-only by design — it does NOT depend on
 * `cron` (the boundary test from Task 2 still passes — no `cron`
 * import appears in core).
 */
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Minimum + maximum number of whitespace-separated fields a valid
 * cron expression can have. Spring Batch / `cronstrue` / Linux
 * `crontab(5)` all agree on 5 (minute, hour, day-of-month, month,
 * day-of-week); Quartz-style extensions add a leading seconds field
 * for 6.
 */
const CRON_MIN_FIELDS = 5;
const CRON_MAX_FIELDS = 6;

/**
 * Cron-shape check.
 *
 * Accepts:
 *   - 5 fields: `minute hour dom month dow` (Linux crontab style)
 *   - 6 fields: `second minute hour dom month dow` (Quartz / Spring
 *     Batch style)
 *
 * Each field is `\S+` (one or more non-whitespace tokens, no empty
 * fields). The trailing `\S+$` is the final field; the leading
 * `(\S+\s+){4,5}` captures the preceding 4 or 5 fields separated by
 * a single whitespace run.
 *
 * This is a shape check, not a semantic one — `99 99 99 99 99` still
 * passes the regex. The runtime scheduler (in `@nest-batch/bullmq`)
 * is the layer that handles semantic validation via `cron-parser`.
 * The shape check exists so the decorator fails fast on
 * unambiguously-wrong input (empty string, too few / too many
 * fields, literal English words).
 */
const CRON_SHAPE = /^(\S+\s+){4,5}\S+$/;

/**
 * IANA timezone validation.
 *
 * The platform's `Intl.DateTimeFormat` is the canonical, no-dep
 * source of truth for valid IANA zone identifiers: it throws a
 * `RangeError` for unknown zones. We use it inside a `try/catch` and
 * normalise the result to a boolean so the decorator's failure mode
 * is a deterministic `Error` (not a `RangeError` leaking out).
 *
 * Reference: https://tc39.es/ecma402/#sec-intl-datetimeformat-constructor
 */
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a cron expression. Throws a deterministic
 * `InvalidBatchScheduledCronError` whose `.message` embeds the
 * invalid value verbatim so log lines and test assertions can pin
 * the error to a specific input.
 */
function assertValidCron(cronExpression: string): void {
  // Type guard: a non-string value would have already broken
  // SetMetadata, but checking here keeps the helper standalone.
  if (typeof cronExpression !== 'string' || cronExpression.length === 0) {
    throw new InvalidBatchScheduledCronError(cronExpression, 'empty');
  }
  if (!CRON_SHAPE.test(cronExpression.trim())) {
    const fieldCount = cronExpression.trim().split(/\s+/).length;
    const reason =
      fieldCount < CRON_MIN_FIELDS
        ? `fewer than ${CRON_MIN_FIELDS} fields`
        : fieldCount > CRON_MAX_FIELDS
          ? `more than ${CRON_MAX_FIELDS} fields`
          : 'not a valid cron expression';
    throw new InvalidBatchScheduledCronError(cronExpression, reason);
  }
}

/**
 * Validate a timezone string. Throws a deterministic
 * `InvalidBatchScheduledTimezoneError` whose `.message` embeds the
 * invalid value verbatim.
 */
function assertValidTimezone(tz: string): void {
  if (typeof tz !== 'string' || tz.trim().length === 0) {
    throw new InvalidBatchScheduledTimezoneError(tz, 'empty');
  }
  if (!isValidIanaTimezone(tz)) {
    throw new InvalidBatchScheduledTimezoneError(tz, 'not a valid IANA timezone');
  }
}

/**
 * Thrown by `@BatchScheduled` when the cron expression fails the
 * shape check (5/6 fields, non-whitespace tokens). The `.message`
 * includes the invalid value and the failure reason so the error
 * is greppable in logs and pinned in test assertions.
 *
 * Exported from the module barrel so adapter packages (e.g. the
 * BullMQ runtime) can `instanceof`-check it without reaching into
 * the decorator's internal helper.
 */
export class InvalidBatchScheduledCronError extends Error {
  readonly cron: string;
  readonly reason: string;

  constructor(cron: string, reason: string) {
    super(
      `[BatchScheduled] invalid cron expression "${cron}": ${reason}. ` +
        `Expected ${CRON_MIN_FIELDS} (Linux crontab) or ${CRON_MAX_FIELDS} (Quartz / Spring Batch) ` +
        `whitespace-separated fields.`,
    );
    this.name = 'InvalidBatchScheduledCronError';
    this.cron = cron;
    this.reason = reason;
  }
}

/**
 * Thrown by `@BatchScheduled` when the IANA timezone fails the
 * platform check. The `.message` embeds the invalid value and the
 * failure reason.
 *
 * Exported from the module barrel so adapter packages can
 * `instanceof`-check it without reaching into the decorator's
 * internal helper.
 */
export class InvalidBatchScheduledTimezoneError extends Error {
  readonly timezone: string;
  readonly reason: string;

  constructor(timezone: string, reason: string) {
    super(
      `[BatchScheduled] invalid timezone "${timezone}": ${reason}. ` +
        `Expected a valid IANA zone identifier (e.g. "UTC", "Asia/Seoul", "America/New_York").`,
    );
    this.name = 'InvalidBatchScheduledTimezoneError';
    this.timezone = timezone;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

export function BatchScheduled(
  cronExpression: string,
  options: BatchScheduledOptions,
): MethodDecorator {
  // 1. Validate inputs at decoration time. The decorator is
  //    synchronous and metadata-only; the validation runs BEFORE
  //    `SetMetadata(...)` is called so a bad input never reaches
  //    the registry.
  assertValidCron(cronExpression);
  assertValidTimezone(options.timezone);

  const meta: BatchScheduledMetadata = {
    cron: cronExpression,
    options,
    inert: process.env.BATCH_SCHEDULED_DISABLE === '1',
  };
  return SetMetadata(BATCH_SCHEDULED_OPTIONS, meta);
}
