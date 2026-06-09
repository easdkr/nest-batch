import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The shared contract suite is shipped as CommonJS from the core
// package (`.swcrc` builds with `module: { type: 'commonjs' }`).
// Its transpiled output does `const _vitest = require("vitest")`,
// which fails because vitest 2.x is ESM-only.
//
// Resolving `@nest-batch/core/test-contracts` to the *source* TS
// file makes the swc vite plugin transform it into ESM on the fly
// (matching `module: { type: 'es6' }` above). The ESM build keeps
// the `import { describe, test, ... } from 'vitest'` statements as
// real ESM imports, which vitest can load.
const coreTestContractsSource = resolve(
  __dirname,
  '../core/tests/contracts/index.ts',
);

export default defineConfig({
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
  resolve: {
    alias: [
      {
        find: '@nest-batch/core/test-contracts',
        replacement: coreTestContractsSource,
      },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    fileParallelism: false,
    server: {
      deps: {
        inline: [
          '@nestjs/core',
          '@nestjs/common',
          '@nestjs/testing',
          '@nest-batch/core',
        ],
      },
    },
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'src/**/*.spec.ts',
    ],
  },
});
