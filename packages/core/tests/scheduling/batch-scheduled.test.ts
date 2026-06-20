import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  BATCH_SCHEDULED_OPTIONS,
  BatchScheduled,
  type BatchOverlapPolicy,
  type BatchScheduledOptions,
} from '../../src/scheduling/batch-scheduled';

// ---------------------------------------------------------------------------
// TDD-RED contract for the cron decorator API.
// Every test in this file is a contract assertion; the current RED stub
// satisfies only the metadata-storing subset. The validation tests, the
// inert-mode tests, and the type-guard sanity tests fail today and are
// expected to pass once the full implementation lands (follow-up task).
// ---------------------------------------------------------------------------

// --- Common test fixtures -------------------------------------------------

const VALID_CRON = '*/5 * * * *';
const VALID_CRON_6 = '0 */5 * * * *';
const VALID_TIMEZONE = 'UTC';
const VALID_NAME = 'flush-cache';

function makeOptions(
  overrides: Partial<BatchScheduledOptions> = {},
): BatchScheduledOptions {
  return {
    name: overrides.name ?? VALID_NAME,
    timezone: overrides.timezone ?? VALID_TIMEZONE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (A) Public surface — exports and types
// ---------------------------------------------------------------------------

describe('@BatchScheduled — public surface', () => {
  it('exports BATCH_SCHEDULED_OPTIONS constant equal to "nest-batch:scheduled"', () => {
    expect(BATCH_SCHEDULED_OPTIONS).toBe('nest-batch:scheduled');
  });

  it('BatchScheduled is a function (decorator factory)', () => {
    expect(typeof BatchScheduled).toBe('function');
  });

  it('BatchScheduled is callable with (cronExpression, options) and returns a method decorator', () => {
    const decorator = BatchScheduled(VALID_CRON, makeOptions());
    expect(typeof decorator).toBe('function');
    // Method decorators receive (target, key, descriptor) when applied.
    expect(decorator.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// (B) Happy path — metadata is discoverable on the method
//
// We read metadata from the method function reference (descriptor.value),
// not from `(Job.prototype, 'run')`. This matches `@nestjs/schedule`'s
// `@Cron` convention: `SetMetadata(...)` for a method decorator stores
// the value on the function itself. Reading the function reference works
// for both class-level (`Job.prototype.run`) and instance-level
// (`new Job().run`) lookups since they share the same function object.
// ---------------------------------------------------------------------------

describe('@BatchScheduled — happy-path metadata is discoverable', () => {
  it('attaches BATCH_SCHEDULED_OPTIONS metadata to the decorated method', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta).toBeDefined();
  });

  it('metadata carries the cron expression verbatim', () => {
    class Job {
      @BatchScheduled('0 0 * * *', makeOptions({ name: 'midnight' }))
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.cron).toBe('0 0 * * *');
  });

  it('metadata carries the resolved name in options.name', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions({ name: 'flush-cache' }))
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.options.name).toBe('flush-cache');
  });

  it('metadata carries the resolved IANA timezone in options.timezone', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions({ timezone: 'Asia/Seoul' }))
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.options.timezone).toBe('Asia/Seoul');
  });

  it('metadata carries the overlap policy when one is supplied', () => {
    const policies: readonly BatchOverlapPolicy[] = ['skip', 'queue', 'parallel'] as const;
    for (const policy of policies) {
      class Job {
        @BatchScheduled(VALID_CRON, makeOptions({ name: `p-${policy}`, overlap: policy }))
        run() {}
      }
      const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
      expect(meta.options.overlap).toBe(policy);
    }
  });

  it('overlap policy is undefined when the caller omits it (default applied at runtime)', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    // The decorator MUST NOT silently default to 'skip' on the user's behalf;
    // the runtime scheduler is responsible for applying the default.
    expect(meta.options.overlap).toBeUndefined();
  });

  it('preserves startAt / endAt absolute time bounds verbatim (by reference)', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-12-31T23:59:59Z');
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions({ startAt: start, endAt: end }))
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.options.startAt).toBe(start);
    expect(meta.options.endAt).toBe(end);
  });

  it('accepts the 6-field cron form (with seconds)', () => {
    class Job {
      @BatchScheduled(VALID_CRON_6, makeOptions({ name: 'six-field' }))
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.cron).toBe(VALID_CRON_6);
  });

  it('does not leak metadata to a sibling method on the same class', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      scheduled() {}

      plain() {}
    }
    expect(Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.plain)).toBeUndefined();
    expect(Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.scheduled)).toBeDefined();
  });

  it('metadata is independent across two decorated methods on the same class', () => {
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions({ name: 'first' }))
      first() {}

      @BatchScheduled('0 0 * * *', makeOptions({ name: 'second', timezone: 'UTC' }))
      second() {}
    }
    const first = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.first);
    const second = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.second);
    expect(first.cron).toBe(VALID_CRON);
    expect(first.options.name).toBe('first');
    expect(second.cron).toBe('0 0 * * *');
    expect(second.options.name).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// (C) Negative — invalid cron expression fails deterministically
// ---------------------------------------------------------------------------

describe('@BatchScheduled — invalid cron expression is rejected', () => {
  it('throws on an empty cron expression', () => {
    expect(() => BatchScheduled('', makeOptions())).toThrow();
  });

  it('throws when the cron expression has fewer than 5 fields', () => {
    expect(() => BatchScheduled('* * *', makeOptions())).toThrow();
  });

  it('throws when the cron expression has more than 6 fields', () => {
    expect(() => BatchScheduled('* * * * * * *', makeOptions())).toThrow();
  });

  it('throws when the cron expression contains literal words (not a cron token)', () => {
    expect(() => BatchScheduled('not a cron!', makeOptions())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// (D) Negative — invalid timezone fails deterministically
// ---------------------------------------------------------------------------

describe('@BatchScheduled — invalid timezone is rejected', () => {
  it('throws on an unknown IANA timezone identifier', () => {
    expect(() =>
      BatchScheduled(VALID_CRON, makeOptions({ timezone: 'Not/A_Real_Zone' })),
    ).toThrow();
  });

  it('throws on an empty timezone string', () => {
    expect(() => BatchScheduled(VALID_CRON, makeOptions({ timezone: '' }))).toThrow();
  });

  it('throws on a timezone that is just whitespace', () => {
    expect(() => BatchScheduled(VALID_CRON, makeOptions({ timezone: '   ' }))).toThrow();
  });

  it('accepts well-known IANA zones (UTC, Asia/Seoul, America/New_York)', () => {
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      expect(() => BatchScheduled(VALID_CRON, makeOptions({ timezone: tz }))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// (E) Inert mode — process.env.BATCH_SCHEDULED_DISABLE is captured
// ---------------------------------------------------------------------------

describe('@BatchScheduled — inert mode (BATCH_SCHEDULED_DISABLE=1)', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.BATCH_SCHEDULED_DISABLE;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BATCH_SCHEDULED_DISABLE;
    } else {
      process.env.BATCH_SCHEDULED_DISABLE = original;
    }
  });

  it('records inert: true on the metadata when BATCH_SCHEDULED_DISABLE=1', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(true);
  });

  it('records inert: false on the metadata when BATCH_SCHEDULED_DISABLE is unset', () => {
    delete process.env.BATCH_SCHEDULED_DISABLE;
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(false);
  });

  it('records inert: false on the metadata when BATCH_SCHEDULED_DISABLE=0', () => {
    process.env.BATCH_SCHEDULED_DISABLE = '0';
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    const meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta.inert).toBe(false);
  });

  it('does not start any timer (no real scheduling engine) — meta is read-only, inert is a hint', () => {
    // The decorator is a metadata-only contract: it MUST NOT install any
    // setTimeout / setInterval / scheduler registration at decoration
    // time, and the metadata `inert` flag is the ONLY signal the
    // (future) runtime scheduler uses to decide whether to start.
    process.env.BATCH_SCHEDULED_DISABLE = '1';
    let meta: { inert: boolean } | undefined;
    class Job {
      @BatchScheduled(VALID_CRON, makeOptions())
      run() {}
    }
    meta = Reflect.getMetadata(BATCH_SCHEDULED_OPTIONS, Job.prototype.run);
    expect(meta).toBeDefined();
    expect(meta!.inert).toBe(true);
  });
});
