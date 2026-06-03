import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { Jobable, Stepable, Tasklet } from '../../src/decorators';
import { JobRegistry } from '../../src/registry/job-registry';
import { BatchExplorer } from '../../src/explorer/batch-explorer';
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import {
  NestBatchModule,
  type NestBatchModuleAsyncOptions,
} from '../../src/module/nest-batch.module';
import type { RefKind } from '../../src/core/ir';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal tasklet job used to verify the explorer → compiler → registry
 * wiring fires on application bootstrap. One @Stepable + @Tasklet method,
 * no listeners, no transitions — the simplest possible valid job.
 */
@Jobable({ id: 'test-job' })
class TestJobClass {
  @Stepable({ id: 's1' })
  @Tasklet()
  async s1(): Promise<void> {
    return;
  }
}

/**
 * A second job used to verify multi-class discovery through the module.
 * Different id from `TestJobClass` so the registry is exercised.
 */
@Jobable({ id: 'other-test-job', restartable: true })
class OtherJobClass {
  @Stepable({ id: 'o1' })
  @Tasklet()
  async run(): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// forRoot — boot
// ---------------------------------------------------------------------------

describe('NestBatchModule.forRoot()', () => {
  it('compiles a test module that imports NestBatchModule.forRoot()', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.init();
    await moduleRef.close();
  });

  it('exposes JobRegistry as an injectable (resolves from the test module)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry).toBeInstanceOf(JobRegistry);
    // No @Jobable providers were registered → registry is empty.
    expect(registry.getAll()).toEqual([]);

    await moduleRef.close();
  });

  it('exposes BatchExplorer and DefinitionCompiler as injectables too', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    await moduleRef.init();
    expect(moduleRef.get(BatchExplorer)).toBeInstanceOf(BatchExplorer);
    expect(moduleRef.get(DefinitionCompiler)).toBeInstanceOf(DefinitionCompiler);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// Explorer → Registry wiring via OnApplicationBootstrap
// ---------------------------------------------------------------------------

describe('NestBatchModule — explorer → registry wiring', () => {
  it('discovers a @Jobable test class and registers it on application bootstrap', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init(); // triggers BatchExplorer.onModuleInit + BatchBootstrapper.onApplicationBootstrap
    const registry = moduleRef.get(JobRegistry);

    expect(registry.has('test-job')).toBe(true);

    const def = registry.get('test-job');
    expect(def.id).toBe('test-job');
    expect(Object.keys(def.steps)).toEqual(['s1']);
    expect(def.startStepId).toBe('s1');
    expect(def.transitions).toEqual([]);
    expect(def.listeners).toEqual([]);

    const step = def.steps['s1']!;
    expect(step.kind).toBe('tasklet');
    expect(step.id).toBe('s1');
    if (step.kind === 'tasklet') {
      // Instance was supplied → compiler emitted a bound BuilderLambda.
      expect(step.tasklet.kind).toBe('builder-lambda');
      expect(typeof step.tasklet.fn).toBe('function');
    }

    await moduleRef.close();
  });

  it('registers multiple @Jobable classes from the same module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [TestJobClass, OtherJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);

    expect(registry.has('test-job')).toBe(true);
    expect(registry.has('other-test-job')).toBe(true);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get('other-test-job').restartable).toBe(true);

    await moduleRef.close();
  });

  it('leaves the registry empty when no @Jobable providers exist', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [
        // A plain, non-@Jobable class — must not register.
        class NotAJob {
          doStuff(): void {}
        },
      ],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.getAll()).toEqual([]);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// forRootAsync — boot with a mock factory
// ---------------------------------------------------------------------------

describe('NestBatchModule.forRootAsync()', () => {
  it('boots with a synchronous mock factory', async () => {
    const asyncOptions: NestBatchModuleAsyncOptions = {
      useFactory: () => ({ explorer: true }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('boots with an async (Promise-returning) mock factory', async () => {
    const asyncOptions: NestBatchModuleAsyncOptions = {
      useFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { explorer: true };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('boots with a factory that injects another provider', async () => {
    const { Module } = await import('@nestjs/common');
    const CONFIG_TOKEN = 'BATCH_FACTORY_CONFIG';
    @Module({
      providers: [{ provide: CONFIG_TOKEN, useValue: { explorer: true } }],
      exports: [CONFIG_TOKEN],
    })
    class ConfigModule {}

    const asyncOptions: NestBatchModuleAsyncOptions = {
      imports: [ConfigModule],
      inject: [CONFIG_TOKEN],
      useFactory: (config: unknown) => config as { explorer: boolean },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRootAsync(asyncOptions)],
      providers: [TestJobClass],
    }).compile();

    await moduleRef.init();
    const registry = moduleRef.get(JobRegistry);
    expect(registry.has('test-job')).toBe(true);

    await moduleRef.close();
  });

  it('exposes JobRegistry as injectable from a forRootAsync module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestBatchModule.forRootAsync({
          useFactory: () => ({ explorer: true }),
        }),
      ],
    }).compile();

    await moduleRef.init();
    expect(moduleRef.get(JobRegistry)).toBeInstanceOf(JobRegistry);

    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// Module shape / API sanity
// ---------------------------------------------------------------------------

describe('NestBatchModule — surface', () => {
  it('forRoot() with no options uses sensible defaults', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    await moduleRef.init();
    // The BATCH_OPTIONS provider is registered with the supplied (empty) options.
    const opts = moduleRef.get<Record<string, unknown>>('BATCH_OPTIONS');
    expect(opts).toEqual({});

    await moduleRef.close();
  });

  it('forRoot(options) forwards the options into the BATCH_OPTIONS provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot({ explorer: true })],
    }).compile();

    await moduleRef.init();
    const opts = moduleRef.get<{ explorer: boolean }>('BATCH_OPTIONS');
    expect(opts).toEqual({ explorer: true });

    await moduleRef.close();
  });
});
