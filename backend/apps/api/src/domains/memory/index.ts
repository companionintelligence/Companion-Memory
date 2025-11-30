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
 *   - `MemoryService`: Provides high-level operations for interacting with the memory graph.
 *   - `ContentService`, `EventService`, `CommunicationService`: Manage specific types of
 *     memory entities.
 *   - `GraphUtilityService`: Offers tools for traversing and manipulating the graph structure.
 * - **Controllers**: Expose REST API endpoints (`MemoryController`, `ContentController`, etc.)
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
import { EmbeddingModule } from '@ci/domains/search';
import { UserModule, UserEntity } from '@ci/domains/user';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
import { GraphController } from './controllers/GraphController';
import { MemoryController } from './controllers/MemoryController';
import { CommunicationEntity } from './entities/CommunicationEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EventEntity } from './entities/EventEntity';
import { FactEntity } from './entities/FactEntity';
import { FileEntity } from './entities/FileEntity';
import { GraphNodeEntity } from './entities/GraphNodeEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { RelationshipEntity } from './entities/RelationshipEntity';
import { ThingEntity } from './entities/ThingEntity';
import { GraphEventListener } from './listeners/GraphEventListener';
import { CommunicationService } from './services/CommunicationService';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { FileService } from './services/FileService';
import { GraphEventService } from './services/GraphEventService';
import { GraphQueryService } from './services/GraphQueryService';
import { GraphReadService } from './services/GraphReadService';
import { GraphUtilityService } from './services/GraphUtilityService';
import { MemoryService } from './services/MemoryService';
import { PersonService } from './services/PersonService';
import { SearchService } from './services/SearchService';
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
      PlaceEntity,
      ThingEntity,
      GraphNodeEntity,
      RelationshipEntity,
      FileEntity,
      BrowserActivityEntity,
      UserEntity,
      RelationshipEntity,
      FactEntity,
    ]),
    UserModule,
    EventsModule,
    EmbeddingModule,
    FilesModule,
    BrowserActivityModule,
  ],
  providers: [
    MemoryService,
    CommunicationService,
    ContentService,
    EventService,
    GraphEventService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    UserContextService,
    GraphEventListener,
    PersonService,
    FileService,
    SearchService,
  ],
  controllers: [MemoryController, ContentController, EventController, GraphController],
  exports: [
    MemoryService,
    CommunicationService,
    ContentService,
    EventService,
    GraphEventService,
    PersonService,
    UserContextService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    FileService,
    SearchService,
  ],
})
export class MemoryModule {}

export {
  CommunicationEntity,
  ContentEntity,
  EventEntity,
  PersonEntity,
  PlaceEntity,
  ThingEntity,
  GraphNodeEntity,
  RelationshipEntity,
};

// Services
export {
  MemoryService,
  ContentService,
  EventService,
  CommunicationService,
  GraphEventService,
  PersonService,
  UserContextService,
  GraphUtilityService,
  GraphQueryService,
  GraphReadService,
  FileService,
  SearchService,
};

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

// Search types
export type {
  SearchMode,
  SearchScope,
  DatabaseSearchOptions,
  SearchResultItem,
  DatabaseSearchResults,
} from './services/SearchService';
