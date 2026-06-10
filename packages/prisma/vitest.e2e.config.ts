import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, '../core/src/index.ts');
const coreContracts = resolve(here, '../core/tests/contracts/index.ts');
const postgresqlSrc = resolve(here, '../postgresql/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@nest-batch/core': coreSrc,
      '@nest-batch/core/test-contracts': coreContracts,
      '@nest-batch/postgresql': postgresqlSrc,
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    // Docker pull + Postgres startup inside beforeAll is the slow
    // path. 60 s covers a cold pull on CI; the cache-hit case
    // finishes in <10 s.
    testTimeout: 60_000,
    // Container teardown can take ~10 s on a busy CI runner.
    hookTimeout: 60_000,
    server: {
      deps: {
        inline: ['@nestjs/core', '@nestjs/common', '@nestjs/testing'],
      },
    },
    include: ['tests/e2e-postgres.test.ts'],
    // No-tests guard: vitest 2.x defaults `passWithNoTests: false`,
    // so a missing or renamed e2e file fails the run with exit 1.
    // The e2e is opt-in (RUN_PRISMA_E2E=1) and uses a skip notice
    // inside the file when the env var is unset, so the file
    // itself is always present and always matched.
    passWithNoTests: true,
  },
});
