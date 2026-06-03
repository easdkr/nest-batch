/**
 * Vitest config for the BullMQ execution-path e2e suite.
 *
 * The demo's `AppModule` reads `BATCH_TRANSPORT` /
 * `BATCH_BULLMQ_AUTOSTART_WORKER` / `BATCH_BULLMQ_KEY_PREFIX` at
 * decorator-evaluation time (when the class is first loaded). ESM
 * hoists `import` statements above any code, so a top-of-file
 * `process.env.X = ...` line in the spec file would not take effect
 * before `AppModule` is evaluated. This config uses a `setupFiles`
 * entry to run the env-var assignment BEFORE the spec is loaded.
 *
 * The match pattern only includes the BullMQ e2e spec, so this
 * config does not run any other suite. The non-BullMQ e2e tests
 * (`import-products.e2e.spec.ts`, `library-integration.e2e.spec.ts`)
 * continue to use the root `vitest.e2e.config.ts`.
 */
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    include: ['tests/e2e/bullmq-import-products.e2e.spec.ts'],
    setupFiles: ['./test/bullmq-e2e-setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: {
          syntax: 'typescript',
          decorators: true,
          dynamicImport: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        keepClassNames: true,
      },
    }),
  ],
});
