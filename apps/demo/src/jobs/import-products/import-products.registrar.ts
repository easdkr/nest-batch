import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BatchExplorer, DefinitionCompiler, JobRegistry } from '@nest-batch/core';

import { ImportProductsJob } from './import-products.job';

const DEFAULT_IMPORT_FILE = 'sample-data/products-valid.csv';

/**
 * Configures the `ImportProductsJob` with the runtime CSV file
 * path at application bootstrap and (defensively) re-registers
 * the discovered job definition.
 *
 * `BatchBootstrapper` (auto-registered by
 * `NestBatchModule.forRoot({ ... })`) already compiles and
 * registers every discovered `@Jobable` class on
 * `onApplicationBootstrap`, so the `registry.has(...)` guard
 * short-circuits the register call in the normal boot path —
 * keeping it here as a defensive fallback if discovery ever
 * silently drops the job.
 */
@Injectable()
export class ImportProductsJobRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImportProductsJobRegistrar.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly compiler: DefinitionCompiler,
    private readonly explorer: BatchExplorer,
    private readonly importProductsJob: ImportProductsJob,
  ) {}

  onApplicationBootstrap(): void {
    const filePath = process.env.IMPORT_FILE ?? DEFAULT_IMPORT_FILE;
    this.importProductsJob.configure(filePath);

    const [discovered] = this.explorer.discoverFromProviders([
      { metatype: ImportProductsJob, instance: this.importProductsJob },
    ]);
    if (!discovered) {
      throw new Error('ImportProductsJob decorator metadata was not discovered');
    }

    const def = this.compiler.compileFromDiscovered(discovered);
    if (this.registry.has(def.id)) {
      this.logger.log(`Job "${def.id}" already registered; skipping duplicate registration`);
      return;
    }
    this.registry.register(def);
    this.logger.log(`Registered job "import-products" with filePath=${filePath}`);
  }
}
