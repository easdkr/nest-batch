import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  ChunkStepExecutor,
  DefinitionCompiler,
  JobExecutor,
  JobLauncher,
  JobRegistry,
  JobRepository,
  ListenerInvoker,
  NestBatchModule,
  TaskletStepExecutor,
  TransactionManager,
} from '@nest-batch/core';
import { AppConfigModule } from './config/config.module';
import { MikroORMJobRepository } from './adapters/mikroorm/mikroorm-job-repository';
import { MikroORMTransactionManager } from './adapters/mikroorm/mikroorm-transaction-manager';
import { BatchController } from './controller/batch.controller';
import { CsvProductReader } from './jobs/import-products/reader/csv-product.reader';
import { ProductProcessor } from './jobs/import-products/processor/product.processor';
import { ProductWriter } from './jobs/import-products/writer/product.writer';
import { ValidateCsvTasklet } from './jobs/import-products/validate-csv.tasklet';
import { ImportProductsJob } from './jobs/import-products/import-products.job';
import {
  JobInstanceEntity,
  JobExecutionEntity,
  JobExecutionParamsEntity,
  StepExecutionEntity,
  JobExecutionContextEntity,
  StepExecutionContextEntity,
} from './entities/job-meta.entities';
import { ProductEntity } from './entities/product.entity';
import { SkipLoggerListener } from './jobs/import-products/listeners/skip-logger.listener';
import { StepMetricsListener } from './jobs/import-products/listeners/step-metrics.listener';

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
      entities: [
        JobInstanceEntity,
        JobExecutionEntity,
        JobExecutionParamsEntity,
        StepExecutionEntity,
        JobExecutionContextEntity,
        StepExecutionContextEntity,
        ProductEntity,
      ],
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
