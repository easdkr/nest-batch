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
    server: {
      deps: {
        inline: ['@nestjs/core', '@nestjs/common', '@nestjs/testing'],
      },
    },
    include: ['tests/e2e/**/*.test.ts'],
    // No-tests guard: vitest 2.x defaults `passWithNoTests: false`,
    // so an empty `tests/e2e/` directory fails the run with exit 1.
    // The real 4-shell e2e suite lands in Task #13; until then, this
    // flag keeps `pnpm test:e2e` (gated by RUN_POSTGRES_E2E=1) green.
    passWithNoTests: true,
  },
});
