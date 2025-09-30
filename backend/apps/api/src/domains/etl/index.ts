import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectionsModule } from '@ci/domains/connections';
import { EventsModule } from '@ci/domains/events';
import { EventEntity } from '@ci/domains/memory';

import { GoogleController } from './controllers/google_controller';
import { ApiLogEntity } from './entities/ApiLogEntity';
import { ApiLogService } from './services/ApiLogService';
import { EventProcessorService } from './services/EventProcessorService';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiLogEntity, EventEntity]),
    ConnectionsModule,
    EventsModule,
  ],
  providers: [ApiLogService, EventProcessorService],
  controllers: [GoogleController],
  exports: [ApiLogService, EventProcessorService],
})
export class EtlModule {}

// Entities
export { ApiLogEntity };

// Services
export { ApiLogService };
export { EventProcessorService };

// Controllers
export { GoogleController };

// Types
export type { ApiLog } from './types';
export type { ParsedEvent, ParsedCalendarEvent, ParsedEmail } from './utils/parser';
