import 'reflect-metadata';
import { describe, expect, test, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { NestBatchModule } from '../../src/module/nest-batch.module';
import { JobLauncher } from '../../src/execution/job-launcher';
import { JobExecutor } from '../../src/execution/job-executor';
import { TaskletStepExecutor } from '../../src/execution/tasklet-step-executor';
import { ChunkStepExecutor } from '../../src/execution/chunk-step-executor';
import { ListenerInvoker } from '../../src/execution/listener-invoker';
import { JobRegistry } from '../../src/registry/job-registry';
import { DefinitionCompiler } from '../../src/compiler/definition-compiler';
import { BatchBuilder } from '../../src/builder/batch-builder';
import { InMemoryJobRepository } from '../../src/repository/in-memory/in-memory-job-repository';
import { InMemoryTransactionManager } from '../../src/transaction/in-memory-transaction-manager';
import { FlowEvaluator } from '../../src/flow/flow-evaluator';
import { RefKind } from '../../src/core/ir';
import { JobStatus } from '../../src/core/status';
import {
  Jobable,
  Stepable,
  Tasklet,
  BeforeJob,
  AfterJob,
  BeforeStep,
  AfterStep,
} from '../../src/decorators';

// ---------------------------------------------------------------------------
// Shared wiring helper (mirrors the pattern from tests/e2e/library-smoke.test.ts
// so the listener wiring is exercised end-to-end through the real Nest
// discovery → compile → register → launch pipeline).
// ---------------------------------------------------------------------------

/**
 * Build a JobLauncher by hand, wiring the dependencies the same way the
 * in-process `job-launcher.test.ts` does. This sidesteps the Nest DI
 * graph (which has a `forwardRef(JobExecutor)` chain in `JobLauncher`
 * that interacts badly with the test-module provider list).
 *
 * The test still boots a real Nest module for the discovery/registry
 * side — we just construct the runtime launcher explicitly to keep the
 * DI surface minimal and let the test focus on listener wiring.
 */
function buildLauncherFromModule(moduleRef: TestingModule): JobLauncher {
  const registry = moduleRef.get(JobRegistry);
  const repository = new InMemoryJobRepository();
  const transactionManager = new InMemoryTransactionManager();
  const listenerInvoker = new ListenerInvoker();
  const taskletExecutor = new TaskletStepExecutor();
  const chunkExecutor = new ChunkStepExecutor();
  const flowEvaluator = moduleRef.get(FlowEvaluator);
  const jobExecutor = new JobExecutor(
    repository,
    transactionManager,
    taskletExecutor,
    chunkExecutor,
    listenerInvoker,
    flowEvaluator,
  );
  return new JobLauncher(registry, repository, jobExecutor);
}

// ===========================================================================
// 1. Decorator-discovered job: all 4 lifecycle listeners fire in order
// ===========================================================================

describe('Listener invocation — decorator-discovered job (Task 4 RED)', () => {
  test('@BeforeJob / @AfterJob / @BeforeStep / @AfterStep each fire exactly once in the documented order', async () => {
    // Spies live in the closure so we can assert call counts after the
    // executor returns. The listener methods push their name into
    // `callOrder` so we can also assert the exact sequence.
    const beforeJobSpy = vi.fn();
    const afterJobSpy = vi.fn();
    const beforeStepSpy = vi.fn();
    const afterStepSpy = vi.fn();
    const callOrder: string[] = [];

    @Jobable({ id: 'listener-invocation-decorator-job' })
    class DecoratedListenerJob {
      @BeforeJob()
      beforeJob(): void {
        beforeJobSpy();
        callOrder.push('beforeJob');
      }

      @AfterJob()
      afterJob(): void {
        afterJobSpy();
        callOrder.push('afterJob');
      }

      @BeforeStep()
      beforeStep(): void {
        beforeStepSpy();
        callOrder.push('beforeStep');
      }

      @AfterStep()
      afterStep(): void {
        afterStepSpy();
        callOrder.push('afterStep');
      }

      @Stepable({ id: 's1' })
      @Tasklet()
      async s1(): Promise<string> {
        return 'ok';
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [DecoratedListenerJob],
    }).compile();

    try {
      await moduleRef.init();
      const registry = moduleRef.get(JobRegistry);
      // Sanity: the explorer → compiler → registry pipeline picked up the
      // @Jobable class. The presence of the job in the registry proves
      // listener metadata is collected at discovery time, even if the
      // resolver map is empty (which is the gap Task 8 closes).
      expect(registry.has('listener-invocation-decorator-job')).toBe(true);

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('listener-invocation-decorator-job');

      // The step itself succeeds. The fact that the listeners are not
      // invoked (today) is what makes this a RED test.
      expect(execution.status).toBe(JobStatus.COMPLETED);

      // RED assertions — each spy is called 0 times today because
      // JobExecutor.buildResolverMap() returns `new Map()`. Task 8 will
      // wire the resolver map and these calls will all become 1.
      expect(beforeJobSpy).toHaveBeenCalledTimes(1);
      expect(beforeStepSpy).toHaveBeenCalledTimes(1);
      expect(afterStepSpy).toHaveBeenCalledTimes(1);
      expect(afterJobSpy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['beforeJob', 'beforeStep', 'afterStep', 'afterJob']);
    } finally {
      await moduleRef.close();
    }
  });
});

// ===========================================================================
// 2. Non-critical listener: throwing must NOT fail the job
// ===========================================================================

describe('Listener invocation — non-critical failure semantics (Task 4 RED)', () => {
  test('a nonCritical @AfterJob listener that throws is contained; job still COMPLETED and other after-listeners still run', async () => {
    // The current decorator API does not yet expose a `nonCritical` option
    // (the listener API consolidation in Task 8 will). To exercise the
    // non-critical failure semantics today, we use the Builder API's
    // addListener() which already accepts `nonCritical: true` on the
    // ListenerDefinition. The compiled JobDefinition is identical in
    // shape regardless of which API produced it — the resolver map is
    // the single point that has to honor the flag.
    const criticalAfterJobSpy = vi.fn();
    const nonCriticalThrowingSpy = vi.fn(() => {
      throw new Error('non-critical-boom');
    });

    const jobConfig = BatchBuilder.create()
      .job('listener-invocation-noncritical')
      .addStep((b) =>
        b.tasklet('s1', {
          kind: RefKind.BuilderLambda,
          fn: async (): Promise<string> => 'ok',
        }),
      )
      .addListener({
        kind: 'job',
        phase: 'after',
        ref: { kind: RefKind.BuilderLambda, fn: criticalAfterJobSpy },
      })
      .addListener({
        kind: 'job',
        phase: 'after',
        nonCritical: true,
        ref: { kind: RefKind.BuilderLambda, fn: nonCriticalThrowingSpy },
      })
      .build();

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    try {
      await moduleRef.init();
      const registry = moduleRef.get(JobRegistry);
      const compiler = moduleRef.get(DefinitionCompiler);
      registry.register(compiler.compileFromBuilderConfig(jobConfig));

      // Sanity: the IR carries the nonCritical flag. The resolver map
      // build must read this and route failures to the warn-and-continue
      // path (currently: resolver map is empty → both spies are 0).
      const registered = registry.get('listener-invocation-noncritical');
      const afterJobDefs = registered.listeners.filter(
        (l) => l.kind === 'job' && l.phase === 'after',
      );
      expect(afterJobDefs).toHaveLength(2);
      expect(afterJobDefs.some((l) => l.nonCritical === true)).toBe(true);
      expect(afterJobDefs.some((l) => l.nonCritical !== true)).toBe(true);

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('listener-invocation-noncritical');

      // RED: today the resolver map is empty → the throwing listener is
      // never invoked and the job is trivially COMPLETED. After Task 8
      // wires the resolver map, the throw must be contained by the
      // nonCritical flag and the job must STILL reach COMPLETED — the
      // critical sibling listener must also still have run.
      expect(execution.status).toBe(JobStatus.COMPLETED);
      expect(nonCriticalThrowingSpy).toHaveBeenCalledTimes(1);
      expect(criticalAfterJobSpy).toHaveBeenCalledTimes(1);
    } finally {
      await moduleRef.close();
    }
  });
});

// ===========================================================================
// 3. Critical listener: throwing fails the job
// ===========================================================================

describe('Listener invocation — critical failure semantics (Task 4 RED)', () => {
  test('a critical @AfterStep listener (default = non-nonCritical) that throws → job FAILED', async () => {
    const beforeJobSpy = vi.fn();
    const afterStepThrowingSpy = vi.fn(() => {
      throw new Error('critical-after-step-boom');
    });

    @Jobable({ id: 'listener-invocation-critical' })
    class CriticalListenerJob {
      @BeforeJob()
      beforeJob(): void {
        beforeJobSpy();
      }

      @AfterStep()
      afterStep(): void {
        afterStepThrowingSpy();
      }

      @Stepable({ id: 's1' })
      @Tasklet()
      async s1(): Promise<string> {
        return 'ok';
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
      providers: [CriticalListenerJob],
    }).compile();

    try {
      await moduleRef.init();
      const registry = moduleRef.get(JobRegistry);
      expect(registry.has('listener-invocation-critical')).toBe(true);

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('listener-invocation-critical');

      // RED: today the resolver map is empty → afterStep never runs →
      // the throw never happens → the job is COMPLETED. After Task 8
      // wires the resolver map, the @AfterStep listener will run, throw,
      // and the propagation contract says the step/job must end in
      // FAILED.
      expect(execution.status).toBe(JobStatus.FAILED);
      // The throwing listener must have actually been invoked — a
      // listener that was silently skipped is a different (worse) bug
      // than one that propagated.
      expect(afterStepThrowingSpy).toHaveBeenCalledTimes(1);
      // @BeforeJob runs before the step, so it must have been invoked
      // before the throw aborted the step's normal path.
      expect(beforeJobSpy).toHaveBeenCalledTimes(1);
    } finally {
      await moduleRef.close();
    }
  });
});

// ===========================================================================
// 4. Builder-defined job: equivalent job-level listener invocation
// ===========================================================================

describe('Listener invocation — builder-defined job parity (Task 4 RED)', () => {
  test('a job with @BeforeJob + @AfterJob listeners built via the fluent API fires both once, beforeJob before afterJob', async () => {
    // The Builder API for step-level listeners is a separate gap (the
    // step-level metadata is currently stored on StepBuilder.listenerDefs
    // but not emitted into the compiled JobDefinition.listeners). The
    // listener wiring that Task 8 closes IS exercised here at the
    // job-level, which is the same resolver map the decorator path uses
    // for job-level listeners. The decorator test above exercises the
    // step-level half of the same resolver map.
    const callOrder: string[] = [];
    const beforeJobSpy = vi.fn(() => callOrder.push('beforeJob'));
    const afterJobSpy = vi.fn(() => callOrder.push('afterJob'));

    const jobConfig = BatchBuilder.create()
      .job('listener-invocation-builder')
      .addStep((b) =>
        b.tasklet('s1', {
          kind: RefKind.BuilderLambda,
          fn: async (): Promise<string> => 'ok',
        }),
      )
      .addListener({
        kind: 'job',
        phase: 'before',
        ref: { kind: RefKind.BuilderLambda, fn: beforeJobSpy },
      })
      .addListener({
        kind: 'job',
        phase: 'after',
        ref: { kind: RefKind.BuilderLambda, fn: afterJobSpy },
      })
      .build();

    const moduleRef = await Test.createTestingModule({
      imports: [NestBatchModule.forRoot()],
    }).compile();

    try {
      await moduleRef.init();
      const registry = moduleRef.get(JobRegistry);
      const compiler = moduleRef.get(DefinitionCompiler);
      registry.register(compiler.compileFromBuilderConfig(jobConfig));

      const launcher = buildLauncherFromModule(moduleRef);
      const execution = await launcher.launch('listener-invocation-builder');

      // RED: today the resolver map is empty → spies called 0 times.
      // After Task 8, both must be called exactly once, in the
      // documented order: before the step / job work, after.
      expect(execution.status).toBe(JobStatus.COMPLETED);
      expect(beforeJobSpy).toHaveBeenCalledTimes(1);
      expect(afterJobSpy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['beforeJob', 'afterJob']);
    } finally {
      await moduleRef.close();
    }
  });
});
