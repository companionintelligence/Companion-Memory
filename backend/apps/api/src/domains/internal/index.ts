import { Module } from '@nestjs/common';

import { InternalController } from './controllers/InternalController';
import { InternalApiGuard } from './guards/InternalApiGuard';

@Module({
  controllers: [InternalController],
  providers: [InternalApiGuard],
})
export class InternalModule {}
