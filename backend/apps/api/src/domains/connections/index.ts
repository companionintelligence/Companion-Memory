import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DataIngestionService } from '@ci/common/services';
import { EventsModule } from '@ci/domains/events';

import { ClientFactory } from './clients';
import { ConnectionsController } from './controllers/ConnectionsController';
import { DataIngestionController } from './controllers/DataIngestionController';
import { ProvidersController } from './controllers/ProvidersController';
import { ApiLogEntity } from './entities/ApiLogEntity';
import { ConnectionEntity } from './entities/ConnectionEntity';
import { ProviderEntity } from './entities/ProviderEntity';
import { ApiLogEventListenerService } from './services/ApiLogEventListenerService';
import { ApiLogPostProcessorService } from './services/ApiLogPostProcessorService';
import { CalendarPaginationService } from './services/CalendarPaginationService';
import { ConnectionService } from './services/ConnectionService';
import { ProviderService } from './services/ProviderService';

@Module({
  imports: [TypeOrmModule.forFeature([ApiLogEntity, ConnectionEntity, ProviderEntity]), EventsModule],
  providers: [
    ClientFactory,
    ConnectionService,
    ProviderService,
    DataIngestionService,
    ApiLogPostProcessorService,
    ApiLogEventListenerService,
    CalendarPaginationService,
  ],
  controllers: [ConnectionsController, DataIngestionController, ProvidersController],
  exports: [
    DataIngestionService,
    ApiLogPostProcessorService,
    ApiLogEventListenerService,
    CalendarPaginationService,
  ],
})
export class ConnectionsModule {}

// Entities
export { ConnectionEntity, ProviderEntity };

// Services
export {};

// Types
export type {} from './types';
