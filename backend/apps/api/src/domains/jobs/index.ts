import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';

import { JobsController } from './controllers/JobsController';
import { JobsService } from './services/JobsService';

@Module({
  imports: [EventsModule],
  providers: [JobsService],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}

// Entities
export {};

// Services
export { JobsService } from './services/JobsService';

// Types
export type {} from './types';
