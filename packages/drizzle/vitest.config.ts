import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, '../core/src/index.ts');
const coreContracts = resolve(here, '../core/tests/contracts/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@nest-batch/core': coreSrc,
      '@nest-batch/core/test-contracts': coreContracts,
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
    // finishes in <10 s. The default `pnpm test` run does NOT
    // start a container (the e2e is opt-in via RUN_DRIZZLE_E2E=1),
    // but the timeout is set on the default config too so a local
    // ad-hoc `pnpm test -- tests/e2e-postgres.test.ts` invocation
    // also works.
    testTimeout: 60_000,
    // Container teardown can take ~10 s on a busy CI runner.
    hookTimeout: 60_000,
    server: {
      deps: {
        inline: ['@nestjs/core', '@nestjs/common', '@nestjs/testing'],
      },
    },
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'src/**/*.spec.ts',
    ],
    // The e2e harness (`tests/e2e-postgres.test.ts`) is opt-in via
    // RUN_DRIZZLE_E2E=1 and requires a Docker daemon + Postgres
    // testcontainer. Keep it out of the default `pnpm test` run;
    // CI runs it via `pnpm test:e2e` (which uses
    // `vitest.e2e.config.ts`).
    exclude: [
      'tests/e2e-postgres.test.ts',
      'node_modules/**',
      'dist/**',
    ],
    // No-tests guard: vitest 2.x defaults `passWithNoTests: false`,
    // so a package with zero matching files fails with exit 1.
    // The e2e suite is opt-in via RUN_DRIZZLE_E2E=1 (separate gated
    // include glob); this guard keeps `pnpm test` green when only
    // the gated e2e harness exists or is temporarily empty.
    passWithNoTests: true,
  },
});
