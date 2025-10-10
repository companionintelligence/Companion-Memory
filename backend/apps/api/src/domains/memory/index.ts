import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
import { GraphController } from './controllers/GraphController';
import { MemoryController } from './controllers/MemoryController';
import { ContactEntity } from './entities/ContactEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EventEntity } from './entities/EventEntity';
import { FactEntity } from './entities/FactEntity';
import { GraphNodeEntity } from './entities/GraphNodeEntity';
import { LocationEntity } from './entities/LocationEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { RelationshipEntity } from './entities/RelationshipEntity';
import { ThingEntity } from './entities/ThingEntity';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { GraphUtilityService } from './services/GraphUtilityService';
import { MemoryService } from './services/MemoryService';
import { UserContextService } from './services/UserContextService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContactEntity,
      ContentEntity,
      EventEntity,
      LocationEntity,
      PersonEntity,
      PlaceEntity,
      ThingEntity,
      GraphNodeEntity,
      RelationshipEntity,
      FactEntity,
    ]),
  ],
  providers: [MemoryService, ContentService, EventService, GraphUtilityService, UserContextService],
  controllers: [MemoryController, ContentController, EventController, GraphController],
  exports: [MemoryService, ContentService, EventService, GraphUtilityService, UserContextService],
})
export class MemoryModule {}

export {
  ContactEntity,
  ContentEntity,
  EventEntity,
  FactEntity,
  LocationEntity,
  PersonEntity,
  PlaceEntity,
  ThingEntity,
  GraphNodeEntity,
  RelationshipEntity,
};

// Services
export { MemoryService, ContentService, EventService, GraphUtilityService, UserContextService };

// Types
export type { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from './types';
export type { UserContext } from './services/UserContextService';
