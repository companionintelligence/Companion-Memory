/**
 * @module GraphModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';
import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { UserModule } from '@ci/domains/user';

import { type EntityIdentifier, EntityIdentifierEntity } from './entities/EntityIdentifierEntity';
import { type ItemRelationship, ItemRelationshipEntity } from './entities/ItemRelationshipEntity';
import { type Node, NodeEntity } from './entities/NodeEntity';
import { type Relationship, RelationshipEntity } from './entities/RelationshipEntity';
import {
  type EntityIdentifierBatchEntry,
  EntityIdentifierService,
  type IdentifierKey,
} from './services/EntityIdentifierService';
import { GraphExpansionService } from './services/GraphExpansionService';
import { GraphIngestService } from './services/GraphIngestService';
import { GraphService } from './services/GraphService';
import { ItemRelationshipService } from './services/ItemRelationshipService';
import { NodeService } from './services/NodeService';
import { RelationshipService } from './services/RelationshipService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NodeEntity,
      RelationshipEntity,
      EntityIdentifierEntity,
      ItemRelationshipEntity,
    ]),
    ConversationModule,
    EmbeddingModule,
    EventsModule,
    MemoryModule,
    NotesModule,
    UserModule,
  ],
  providers: [
    EntityIdentifierService,
    GraphExpansionService,
    GraphIngestService,
    GraphService,
    ItemRelationshipService,
    NodeService,
    RelationshipService,
  ],
  exports: [
    EntityIdentifierService,
    GraphExpansionService,
    GraphIngestService,
    GraphService,
    ItemRelationshipService,
    NodeService,
    RelationshipService,
  ],
})
export class GraphModule {}

export {
  EntityIdentifierService,
  GraphExpansionService,
  GraphIngestService,
  GraphService,
  ItemRelationshipService,
  NodeService,
  RelationshipService,
};
export { EntityIdentifierEntity, ItemRelationshipEntity, NodeEntity, RelationshipEntity };
export type {
  EntityIdentifier,
  EntityIdentifierBatchEntry,
  IdentifierKey,
  ItemRelationship,
  Node,
  Relationship,
};
export type {
  GraphEntityInputDto,
  GraphEntityMappingDto,
  GraphRelationshipInputDto,
  GraphIngestResult,
} from './services/GraphIngestService';
export type {
  ItemRelationshipInputDto,
  BulkItemRelationshipResult,
} from './services/ItemRelationshipService';
export { RelationshipMap, RelationshipType } from './types';
export {
  type IdentifierKind,
  type PersonNameParts,
  classifyParticipant,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  splitPersonName,
} from './utils/normalizeIdentifier';
