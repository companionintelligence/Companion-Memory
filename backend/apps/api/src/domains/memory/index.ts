import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { GraphModule, GraphNodeEntity, RelationshipEntity } from '@ci/domains/graph';
import { UserModule } from '@ci/domains/user';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
import { GraphController } from './controllers/GraphController';
import { MemoryController } from './controllers/MemoryController';
import { CommunicationEntity } from './entities/CommunicationEntity';
import { ContactEntity } from './entities/ContactEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EventEntity } from './entities/EventEntity';
import { LocationEntity } from './entities/LocationEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { ThingEntity } from './entities/ThingEntity';
import { CommunicationService } from './services/CommunicationService';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { GraphEventService } from './services/GraphEventService';
import { MemoryService } from './services/MemoryService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunicationEntity,
      ContactEntity,
      ContentEntity,
      EventEntity,
      LocationEntity,
      PersonEntity,
      PlaceEntity,
      ThingEntity,
      GraphNodeEntity,
      RelationshipEntity,
    ]),
    UserModule,
    EventsModule,
    GraphModule,
  ],
  providers: [MemoryService, CommunicationService, ContentService, EventService, GraphEventService],
  controllers: [MemoryController, ContentController, EventController, GraphController],
  exports: [MemoryService, CommunicationService, ContentService, EventService, GraphEventService],
})
export class MemoryModule {}

export {
  CommunicationEntity,
  ContactEntity,
  ContentEntity,
  EventEntity,
  LocationEntity,
  PersonEntity,
  PlaceEntity,
  ThingEntity,
};

// Services
export { MemoryService, ContentService, EventService, CommunicationService, GraphEventService };

// Types
export type {
  Memory,
  MemoryLocation,
  MemoryResponse,
  MemorySearchParams,
  CreateEventDto,
  UpdateEventDto,
  CreateContentDto,
  UpdateContentDto,
} from './types';
