import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

function repoFileExists(relPath: string): boolean {
  return existsSync(join(REPO_ROOT, relPath));
}

function exactRepoEntryExists(relPath: string): boolean {
  const parent = dirname(relPath);
  const parentDir = parent === '.' ? REPO_ROOT : join(REPO_ROOT, parent);
  return readdirSync(parentDir).includes(basename(relPath));
}

function packageNames(): string[] {
  return readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => repoFileExists(`packages/${name}/package.json`))
    .sort();
}

const PUBLIC_DOCS = [
  'README.md',
  'README.ko.md',
  'docs/getting-started.md',
  'docs/getting-started.ko.md',
  'docs/concepts.md',
  'docs/concepts.ko.md',
  'docs/adapters.md',
  'docs/adapters.ko.md',
  'docs/recipes.md',
  'docs/recipes.ko.md',
  'docs/faq.md',
  'docs/faq.ko.md',
] as const;

const REMOVED_INTERNAL_DOCS = [
  'MIGRATION.md',
  'goal.md',
  'docs/ARCHITECTURE.md',
  'docs/FAQ.md',
  'docs/QUICKSTART.md',
  'docs/RELEASE-0.2.0.md',
] as const;

const INTERNAL_DOC_PATTERNS = [
  /MIGRATION\.md/,
  /goal\.md/,
  /RELEASE-0\.2\.0/,
  /workspace:\*/,
  /acceptance-gate/i,
  /release-roadmap/i,
  /source of truth is this test/i,
] as const;

describe('public documentation', () => {
  it('keeps the current bilingual docs set in place', () => {
    for (const relPath of PUBLIC_DOCS) {
      expect(repoFileExists(relPath), `${relPath} should exist`).toBe(true);
    }
  });

  it('keeps internal implementation notes out of the public docs tree', () => {
    for (const relPath of REMOVED_INTERNAL_DOCS) {
      expect(exactRepoEntryExists(relPath), `${relPath} should stay removed`).toBe(false);
    }
  });

  it('does not link to removed docs or internal planning language', () => {
    const offenders: string[] = [];

    for (const relPath of PUBLIC_DOCS) {
      const text = readRepoFile(relPath);
      for (const pattern of INTERNAL_DOC_PATTERNS) {
        if (pattern.test(text)) {
          offenders.push(`${relPath}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('explains persistence and transport adapters as different runtime roles', () => {
    const rootReadme = readRepoFile('README.md');
    const adaptersGuide = readRepoFile('docs/adapters.md');
    const koreanReadme = readRepoFile('README.ko.md');
    const koreanAdaptersGuide = readRepoFile('docs/adapters.ko.md');

    expect(rootReadme).toContain('Persistence adapter');
    expect(rootReadme).toContain('Transport adapter');
    expect(adaptersGuide).toContain('Where is durable batch state stored?');
    expect(adaptersGuide).toContain('Where does execution actually happen?');

    expect(koreanReadme).toContain('Persistence 어댑터');
    expect(koreanReadme).toContain('Transport 어댑터');
    expect(koreanAdaptersGuide).toContain('durable batch state를 어디에 저장하나요?');
    expect(koreanAdaptersGuide).toContain('실행이 실제로 어디서 일어나나요?');
  });

  it('ships Korean READMEs for every published package', () => {
    for (const packageName of packageNames()) {
      const packageJson = JSON.parse(readRepoFile(`packages/${packageName}/package.json`)) as {
        private?: boolean;
        files?: string[];
      };

      if (packageJson.private === true) {
        continue;
      }

      expect(repoFileExists(`packages/${packageName}/README.md`)).toBe(true);
      expect(repoFileExists(`packages/${packageName}/README.ko.md`)).toBe(true);
      expect(packageJson.files).toContain('README.md');
      expect(packageJson.files).toContain('README.ko.md');
    }
  });
});
