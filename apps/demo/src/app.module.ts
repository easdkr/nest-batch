import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InProcessAdapter, NestBatchModule } from '@nest-batch/core';
import { BATCH_META_ENTITIES, MikroOrmAdapter } from '@nest-batch/mikro-orm';
import { BullmqAdapter } from '@nest-batch/bullmq';
import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { BatchController } from './controller/batch.controller';
import { ProductEntity } from './entities/product.entity';
import { ImportProductsJob } from './jobs/import-products/import-products.job';
import { ImportProductsJobRegistrar } from './jobs/import-products/import-products.registrar';
import { SkipLoggerListener } from './jobs/import-products/listeners/skip-logger.listener';
import { StepMetricsListener } from './jobs/import-products/listeners/step-metrics.listener';
import { ProductProcessor } from './jobs/import-products/processor/product.processor';
import { ProductWriter } from './jobs/import-products/writer/product.writer';

@Module({
  imports: [
    AppConfigModule,
    MikroOrmModule.forRoot({
      entities: [ProductEntity, ...BATCH_META_ENTITIES],
      dbName: process.env.DATABASE_NAME ?? 'nest_batch_demo',
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: Number(process.env.DATABASE_PORT ?? 5434),
      user: process.env.DATABASE_USER ?? 'demo',
      password: process.env.DATABASE_PASSWORD ?? 'demo',
      driver: PostgreSqlDriver,
    }),
    NestBatchModule.forRoot({
      adapters: {
        persistence: MikroOrmAdapter.forRoot(),
        transport:
          process.env.BATCH_TRANSPORT === 'in-process'
            ? InProcessAdapter.forRoot()
            : BullmqAdapter.forRoot({
                connection: {
                  host: process.env.REDIS_HOST ?? '127.0.0.1',
                  port: Number(process.env.REDIS_PORT ?? 6379),
                  keyPrefix: process.env.BATCH_BULLMQ_KEY_PREFIX || undefined,
                },
                autoStartWorker:
                  process.env.BATCH_BULLMQ_AUTOSTART_WORKER === '1' ||
                  process.env.BATCH_BULLMQ_AUTOSTART_WORKER === 'true',
              }),
      },
    }),
  ],
  controllers: [BatchController],
  providers: [
    ProductProcessor,
    ProductWriter,
    ImportProductsJob,
    SkipLoggerListener,
    StepMetricsListener,
    ImportProductsJobRegistrar,
  ],
})
export class AppModule {}
