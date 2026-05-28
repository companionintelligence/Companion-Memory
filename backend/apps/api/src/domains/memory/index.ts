/**
 * This module is responsible for managing the application's long-term, structured memory.
 * It functions as a knowledge graph, storing and organizing information about various
 * entities such as people, places, events, and content. This allows the AI to build a
 * persistent and interconnected understanding of the user's world.
 *
 * ### Key Components:
 * - **Entities**: A rich set of entities (`PersonEntity`, `EventEntity`, `ContentEntity`,
 *   `GraphNodeEntity`, `RelationshipEntity`, etc.) that define the structure of the
 *   knowledge graph.
 * - **Services**:
 *   - `GraphUtilityService`: Offers tools for traversing and manipulating the graph structure.
 * - **Controllers**: Expose REST API endpoints (`ContentController`, etc.)
 *   for creating, retrieving, and managing memory entities.
 * - **User Integration**: Connects with the `UserModule` to ensure all memory entities are
 *   scoped to the correct user.
 *
 * @module MemoryModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BrowserActivityModule, BrowserActivityEntity } from '@ci/domains/browser-activity';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { UserModule, UserEntity } from '@ci/domains/user';

import { GraphController } from './controllers/GraphController';
import { type Communication, CommunicationEntity } from './entities/CommunicationEntity';
import { type Concept, ConceptEntity } from './entities/ConceptEntity';
import { ContentEntity } from './entities/ContentEntity';
import { type Event, EventEntity } from './entities/EventEntity';
import { FileEntity } from './entities/FileEntity';
import { GraphNodeEntity } from './entities/GraphNodeEntity';
import { type Item, type InventoryCondition, ItemEntity } from './entities/ItemEntity';
import { type Person, PersonEntity } from './entities/PersonEntity';
import { type Place, PlaceEntity } from './entities/PlaceEntity';
import { RelationshipEntity } from './entities/RelationshipEntity';
import { ThingEntity } from './entities/ThingEntity';
import { GraphEventListener } from './listeners/GraphEventListener';
import { CommunicationService } from './services/CommunicationService';
import { ConceptService } from './services/ConceptService';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { FileService } from './services/FileService';
import { GraphEventService } from './services/GraphEventService';
import { GraphQueryService } from './services/GraphQueryService';
import { GraphReadService } from './services/GraphReadService';
import { GraphUtilityService } from './services/GraphUtilityService';
import { ItemService } from './services/ItemService';
import { PersonService } from './services/PersonService';
import { PlaceService } from './services/PlaceService';
import { UserContextService } from './services/UserContextService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunicationEntity,
      ContentEntity,
      EventEntity,
      PersonEntity,
      ConceptEntity,
      PlaceEntity,
      ThingEntity,
      GraphNodeEntity,
      ItemEntity,
      RelationshipEntity,
      FileEntity,
      BrowserActivityEntity,
      UserEntity,
      RelationshipEntity,
    ]),
    UserModule,
    EventsModule,
    FilesModule,
    BrowserActivityModule,
  ],
  providers: [
    CommunicationService,
    ContentService,
    EventService,
    GraphEventService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    ItemService,
    UserContextService,
    GraphEventListener,
    PersonService,
    ConceptService,
    FileService,
    PlaceService,
  ],
  controllers: [GraphController],
  exports: [
    CommunicationService,
    ContentService,
    EventService,
    GraphEventService,
    ItemService,
    PersonService,
    ConceptService,
    UserContextService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    FileService,
    PlaceService,
  ],
})
export class MemoryModule {}

export {
  CommunicationEntity,
  ContentEntity,
  EventEntity,
  FileEntity,
  ItemEntity,
  PersonEntity,
  ConceptEntity,
  PlaceEntity,
  ThingEntity,
  GraphNodeEntity,
  RelationshipEntity,
};

// Services
export {
  ContentService,
  EventService,
  CommunicationService,
  GraphEventService,
  ItemService,
  PersonService,
  ConceptService,
  UserContextService,
  GraphUtilityService,
  GraphQueryService,
  GraphReadService,
  FileService,
  PlaceService,
};

export type { Content } from './entities/ContentEntity';
export type { CreateEventDto, UpdateEventDto, CreateContentDto, UpdateContentDto } from './types';
export type { Concept, Event, Item, InventoryCondition, Person, Communication, Place };
export {
  CommunicationDirection,
  CommunicationType,
  CreateCommunicationDto,
  UpdateCommunicationDto,
} from './types';
