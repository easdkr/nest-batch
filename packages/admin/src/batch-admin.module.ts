import { Module } from '@nestjs/common';

import { BatchAdminController } from './batch-admin.controller';

@Module({
  controllers: [BatchAdminController],
})
export class BatchAdminModule {}
