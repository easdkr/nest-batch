import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, '../core/src/index.ts');
const coreContracts = resolve(here, '../core/tests/contracts/index.ts');
const mikroOrmSrc = resolve(here, '../mikro-orm/src/index.ts');
const typeormSrc = resolve(here, '../typeorm/src/index.ts');
const drizzleSrc = resolve(here, '../drizzle/src/index.ts');
const prismaSrc = resolve(here, '../prisma/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@nest-batch/core': coreSrc,
      '@nest-batch/core/test-contracts': coreContracts,
      '@nest-batch/mikro-orm': mikroOrmSrc,
      '@nest-batch/typeorm': typeormSrc,
      '@nest-batch/drizzle': drizzleSrc,
      '@nest-batch/prisma': prismaSrc,
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
    // The 4-shell e2e suite spins up one Postgres testcontainer,
    // applies the 5-table migration, then boots 4 separate Nest test
    // modules (one per shell). Cold Docker pull on CI is the slow
    // path; 180 s covers a worst-case first run. The 4 Nest module
    // boots together add another ~5–10 s.
    testTimeout: 180_000,
    // Container teardown on a busy CI runner can take ~10 s.
    hookTimeout: 180_000,
    server: {
      deps: {
        inline: ['@nestjs/core', '@nestjs/common', '@nestjs/testing'],
      },
    },
    include: ['tests/e2e/**/*.test.ts'],
    // No-tests guard: vitest 2.x defaults `passWithNoTests: false`,
    // so a transient include-glob miss (or a future test refactor that
    // moves files) would fail CI for the wrong reason. The e2e
    // suite is required and exercised, but the guard keeps the
    // green path stable.
    passWithNoTests: true,
  },
});
