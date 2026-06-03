/**
 * Vitest setup for the BullMQ execution-path e2e suite
 * (`apps/demo/tests/e2e/bullmq-import-products.e2e.spec.ts`).
 *
 * Sets the env vars that the demo's `AppModule` reads at decorator
 * evaluation time. They MUST be set before `AppModule` is imported
 * (the `@Module(buildAppModuleBody())` decorator runs at class load
 * time and reads `process.env.BATCH_TRANSPORT` /
 * `BATCH_BULLMQ_AUTOSTART_WORKER` / `BATCH_BULLMQ_KEY_PREFIX`). A
 * regular top-of-file `process.env.X = ...` line is NOT enough —
 * ESM hoists `import` statements above any code, so the env var
 * would be set AFTER `AppModule` has already been evaluated.
 *
 * This setup file is referenced only by
 * `apps/demo/vitest.bullmq-e2e.config.ts`, so the other e2e files
 * (which use `Test.createTestingModule` and do not import
 * `AppModule`) are unaffected.
 */
import 'reflect-metadata';

const KEY_PREFIX = `e2e-bullmq-demo:${process.pid}:${Date.now().toString(36)}:`;

process.env.BATCH_TRANSPORT = 'bullmq';
process.env.BATCH_BULLMQ_AUTOSTART_WORKER = '1';
process.env.BATCH_BULLMQ_KEY_PREFIX = KEY_PREFIX;
process.env.REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
process.env.DATABASE_HOST = process.env.DATABASE_HOST ?? '127.0.0.1';
process.env.DATABASE_PORT = process.env.DATABASE_PORT ?? '5434';
process.env.DATABASE_USER = process.env.DATABASE_USER ?? 'demo';
process.env.DATABASE_PASSWORD = process.env.DATABASE_PASSWORD ?? 'demo';
process.env.DATABASE_NAME = process.env.DATABASE_NAME ?? 'nest_batch_demo';
