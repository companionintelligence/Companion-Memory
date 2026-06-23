import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { BrowserActivityController } from './controllers/BrowserActivityController';
import { BrowserActivityEntity, type BrowserActivity } from './entities/BrowserActivityEntity';
import { BrowserActivityService } from './services/BrowserActivityService';

@Module({
  imports: [TypeOrmModule.forFeature([BrowserActivityEntity]), EventsModule],
  providers: [BrowserActivityService],
  controllers: [BrowserActivityController],
  exports: [BrowserActivityService],
})
export class BrowserActivityModule {}

// Entities
export { BrowserActivityEntity, type BrowserActivity };

// Services
export { BrowserActivityService };

// DTOs
export type { CreateBrowserActivityDto, UpdateBrowserActivityDto } from './types';
