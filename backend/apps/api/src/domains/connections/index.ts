import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { ClientFactory, HomeAssistantClient } from './clients';
import { ConnectionsController } from './controllers/ConnectionsController';
import { ProvidersController } from './controllers/ProvidersController';
import { HomeAssistantController } from './controllers/HomeAssistantController';
import { ApiLogEntity } from './entities/ApiLogEntity';
import { ConnectionEntity } from './entities/ConnectionEntity';
import { ProviderEntity } from './entities/ProviderEntity';
import { ConnectionService } from './services/ConnectionService';
import { ProviderService } from './services/ProviderService';
import { HomeAssistantAutomationService } from './services/HomeAssistantAutomationService';

@Module({
  imports: [TypeOrmModule.forFeature([ApiLogEntity, ConnectionEntity, ProviderEntity]), EventsModule],
  providers: [
    ClientFactory, 
    HomeAssistantClient,
    ConnectionService, 
    ProviderService,
    HomeAssistantAutomationService,
  ],
  controllers: [
    ConnectionsController, 
    ProvidersController,
    HomeAssistantController,
  ],
  exports: [],
})
export class ConnectionsModule {}

// Entities
export { ConnectionEntity, ProviderEntity };

// Services
export {};

// Types
export type {} from './types';
