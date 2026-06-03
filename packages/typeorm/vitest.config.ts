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
      // Use source of @nest-batch/core directly (no build step required).
      '@nest-batch/core': coreSrc,
      // The shared contract suite ships as a source file in core, not
      // as a built artifact. Re-export it under the canonical
      // `@nest-batch/core/test-contracts` subpath that the contract
      // docs reference.
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
    // TypeORM relies on its decorator metadata being preserved at
    // runtime; the @nestjs/* family of packages must be inlined so
    // the decorator transform applies to them. TypeORM itself is
    // loaded by the SSR runtime through its CJS entry point, not
    // inlined.
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
  },
});
