import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  ChunkStepExecutor,
  DefinitionCompiler,
  InProcessExecutionStrategy,
  IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
  JobExecutor,
  JobLauncher,
  JobRegistry,
  JobRepository,
  ListenerInvoker,
  NestBatchModule,
  TaskletStepExecutor,
  TransactionManager,
} from '@nest-batch/core';
import {
  BATCH_META_ENTITIES,
  MikroORMJobRepository,
  MikroORMTransactionManager,
} from '@nest-batch/mikro-orm';
import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfigModule } from './config/config.module';
import { BatchController } from './controller/batch.controller';
import { ProductEntity } from './entities/product.entity';
import { ImportProductsJob } from './jobs/import-products/import-products.job';
import { SkipLoggerListener } from './jobs/import-products/listeners/skip-logger.listener';
import { StepMetricsListener } from './jobs/import-products/listeners/step-metrics.listener';
import { ProductProcessor } from './jobs/import-products/processor/product.processor';
import { CsvProductReader } from './jobs/import-products/reader/csv-product.reader';
import { ValidateCsvTasklet } from './jobs/import-products/validate-csv.tasklet';
import { ProductWriter } from './jobs/import-products/writer/product.writer';

const DEFAULT_IMPORT_FILE = 'sample-data/products-valid.csv';

/**
 * Builds the `import-products` job and registers it with the
 * `JobRegistry` on application bootstrap.
 *
 * Registered as a singleton via the `useFactory` provider below. The
 * `filePath` is captured at construction time — the MVP exposes a
 * single file per process; per-launch file overrides are passed via
 * the REST controller's request body.
 */
@Injectable()
class ImportProductsJobRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImportProductsJobRegistrar.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly compiler: DefinitionCompiler,
    private readonly productProcessor: ProductProcessor,
    private readonly productWriter: ProductWriter,
  ) {}

  onApplicationBootstrap(): void {
    const filePath = process.env.IMPORT_FILE ?? DEFAULT_IMPORT_FILE;
    const config = ImportProductsJob.build(
      filePath,
      () => new CsvProductReader(filePath),
      () => this.productProcessor,
      () => this.productWriter,
    );
    const def = this.compiler.compileFromBuilderConfig(config);
    this.registry.register(def);
    this.logger.log(`Registered job "import-products" with filePath=${filePath}`);
  }
}

@Module({
  imports: [
    AppConfigModule,
    MikroOrmModule.forRoot({
      entities: [...BATCH_META_ENTITIES, ProductEntity],
      dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: Number(process.env.DATABASE_PORT ?? 5434),
      user: process.env.DATABASE_USER ?? 'demo',
      password: process.env.DATABASE_PASSWORD ?? 'demo',
      driver: PostgreSqlDriver,
    }),
    NestBatchModule.forRoot(),
  ],
  controllers: [BatchController],
  providers: [
    { provide: JobRepository, useClass: MikroORMJobRepository },
    { provide: TransactionManager, useClass: MikroORMTransactionManager },
    JobLauncher,
    JobExecutor,
    ChunkStepExecutor,
    TaskletStepExecutor,
    ListenerInvoker,
    InProcessExecutionStrategy,
    IN_PROCESS_EXECUTION_STRATEGY_PROVIDER,
    ProductProcessor,
    ProductWriter,
    SkipLoggerListener,
    StepMetricsListener,
    {
      provide: ImportProductsJobRegistrar,
      useFactory: (
        registry: JobRegistry,
        compiler: DefinitionCompiler,
        processor: ProductProcessor,
        writer: ProductWriter,
      ) => new ImportProductsJobRegistrar(registry, compiler, processor, writer),
      inject: [JobRegistry, DefinitionCompiler, ProductProcessor, ProductWriter],
    },
  ],
})
export class AppModule {}
