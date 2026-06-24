import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const __dirname = dirname(__filename);

// packages/core/tests/release-0.2.0 -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function readDoc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

interface PhraseCheck {
  readonly phrase: string;
  readonly files: readonly string[];
  readonly note: string;
}

const STALE_PHRASE_CHECKS: readonly PhraseCheck[] = [
  {
    phrase: 'Drizzle not in this release',
    files: ['MIGRATION.md', 'README.md', 'docs/FAQ.md', 'docs/ARCHITECTURE.md'],
    note: "stale 'Drizzle not in this release' phrase found in {file} — see docs/RELEASE-0.2.0.md §3.2 / §4 (Drizzle ships in 0.2.0 as @nest-batch/drizzle)",
  },
  {
    phrase: "what's still on the roadmap is the optional scheduler",
    files: ['README.md'],
    note: "stale 'what\\'s still on the roadmap is the optional scheduler' phrase found in {file} — see docs/RELEASE-0.2.0.md §3.1 / §4 (InProcessSchedule and BullmqSchedule fire cron today)",
  },
  {
    phrase: 'no Kafka transport',
    files: ['MIGRATION.md'],
    note: "stale 'no Kafka transport' clause found in {file} — see docs/RELEASE-0.2.0.md §3 (Kafka ships in 0.2.0 as @nest-batch/kafka)",
  },
  {
    phrase: 'Today the decorator is useful for declaring intent',
    files: ['docs/FAQ.md'],
    note: "stale 'Today the decorator is useful for declaring intent' phrase found in {file} — see docs/RELEASE-0.2.0.md §4 (InProcessSchedule and BullmqSchedule launch non-inert @BatchScheduled entries)",
  },
];

// 50 chars or fewer between "future enhancement" and "partitionIndex".
// The 0.1.0 docs used this exact wording in ARCHITECTURE.md §3 to mark
// the partition contract as deferred. 0.2.0 ships it; the phrase must
// be gone.
const PARTITION_FUTURE_RE = /future enhancement[\s\S]{0,50}partitionIndex/;

describe('T-AC-1 doc-currency (release-0.2.0)', () => {
  describe('the 5 stale phrases from the 0.1.0 docs are absent', () => {
    for (const check of STALE_PHRASE_CHECKS) {
      it(`does not contain "${check.phrase}" in the 4 stale doc files`, () => {
        const offenders: string[] = [];
        for (const rel of check.files) {
          const text = readDoc(rel);
          if (text.includes(check.phrase)) {
            offenders.push(rel);
          }
        }
        if (offenders.length > 0) {
          throw new Error(check.note.replace('{file}', offenders.join(', ')));
        }
        expect(offenders).toEqual([]);
      });
    }
  });

  it('does not contain "future enhancement" within 50 chars of "partitionIndex" in docs/ARCHITECTURE.md', () => {
    const text = readDoc('docs/ARCHITECTURE.md');
    const match = text.match(PARTITION_FUTURE_RE);
    if (match !== null) {
      throw new Error(
        `stale 'future enhancement ... partitionIndex' phrase found in docs/ARCHITECTURE.md (matched: "${match[0]}") — see docs/RELEASE-0.2.0.md §6 (partition orchestration ships in 0.2.0)`,
      );
    }
    expect(match).toBeNull();
  });

  it('docs/RELEASE-0.2.0.md exists (T1 must have shipped it before T-AC-1)', () => {
    const text = readDoc('docs/RELEASE-0.2.0.md');
    expect(text.length).toBeGreaterThan(0);
  });

  it('docs/RELEASE-0.2.0.md contains the 10-package list (3 new + 7 existing)', () => {
    const text = readDoc('docs/RELEASE-0.2.0.md');
    // 3 NEW packages from 0.2.0
    for (const pkg of ['@nest-batch/mysql', '@nest-batch/webhook', '@nest-batch/postgresql']) {
      if (!text.includes(pkg)) {
        throw new Error(
          `docs/RELEASE-0.2.0.md is missing the NEW package "${pkg}" — see §2 (the 10 packages in 0.2.0)`,
        );
      }
    }
    // 7 EXISTING packages (the 0.1.0 set was 3, but T1's plan also includes
    // drizzle / kafka / prisma as 0.1.0 packages that were previously undocumented;
    // RELEASE-0.2.0.md should reference all 7).
    for (const pkg of [
      '@nest-batch/core',
      '@nest-batch/mikro-orm',
      '@nest-batch/typeorm',
      '@nest-batch/drizzle',
      '@nest-batch/prisma',
      '@nest-batch/bullmq',
      '@nest-batch/kafka',
    ]) {
      if (!text.includes(pkg)) {
        throw new Error(
          `docs/RELEASE-0.2.0.md is missing the existing package "${pkg}" — see §2 (the 10 packages in 0.2.0)`,
        );
      }
    }
  });
});
