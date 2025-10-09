import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
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
  providers: [MemoryService, ContentService, EventService, GraphUtilityService],
  controllers: [MemoryController, ContentController, EventController],
  exports: [MemoryService, ContentService, EventService, GraphUtilityService],
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
export { MemoryService, ContentService, EventService, GraphUtilityService };

// Types
export type { Memory, MemoryLocation, MemoryResponse, MemorySearchParams } from './types';
