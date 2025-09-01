import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';

import { JobsController } from './controllers/JobsController';

@Module({
  imports: [EventsModule, FilesModule],
  providers: [],
  controllers: [JobsController],
  exports: [],
})
export class JobsModule {}

// Entities
export {};

// Services
export {};

// Types
export type {} from './types';
