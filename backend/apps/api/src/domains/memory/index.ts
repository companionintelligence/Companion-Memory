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
import { GraphModule, GraphNodeEntity, RelationshipEntity } from '@ci/domains/graph';
import { EmbeddingModule } from '@ci/domains/search';
import { UserModule } from '@ci/domains/user';

import { ContentController } from './controllers/ContentController';
import { EventController } from './controllers/EventController';
import { GraphController } from './controllers/GraphController';
import { MemoryController } from './controllers/MemoryController';
import { CommunicationEntity } from './entities/CommunicationEntity';
import { ContactEntity } from './entities/ContactEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EventEntity } from './entities/EventEntity';
import { FileEntity } from './entities/FileEntity';
import { LocationEntity } from './entities/LocationEntity';
import { PersonEntity } from './entities/PersonEntity';
import { PlaceEntity } from './entities/PlaceEntity';
import { ThingEntity } from './entities/ThingEntity';
import { CommunicationService } from './services/CommunicationService';
import { ContentService } from './services/ContentService';
import { EventService } from './services/EventService';
import { GraphEventService } from './services/GraphEventService';
import { MemoryService } from './services/MemoryService';

/**
 * @internal
 */
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
      FileEntity,
      BrowserActivityEntity,
    ]),
    UserModule,
    EventsModule,
    GraphModule,
    EmbeddingModule,
    FilesModule,
    BrowserActivityModule,
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
