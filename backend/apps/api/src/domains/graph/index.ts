/**
 * @module GraphModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';
import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { MemoryModule, SELF_ENTITY_PROVISIONER } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { UserModule } from '@ci/domains/user';

import { type EntityIdentifier, EntityIdentifierEntity } from './entities/EntityIdentifierEntity';
import { type ItemRelationship, ItemRelationshipEntity } from './entities/ItemRelationshipEntity';
import { type Node, NodeEntity } from './entities/NodeEntity';
import {
  type ObjectIdentifier,
  ObjectIdentifierEntity,
  type ObjectIdentifierSubjectType,
} from './entities/ObjectIdentifierEntity';
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
import {
  type ObjectIdentifierBatchEntry,
  type ObjectIdentifierMatch,
  ObjectIdentifierService,
  type RawObjectIdentifier,
} from './services/ObjectIdentifierService';
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
      ObjectIdentifierEntity,
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
    // Memory's KnownPlacesService needs the self entity provisioned, and cannot
    // inject GraphIngestService itself — see memory/services/selfEntityProvisioner.ts.
    { provide: SELF_ENTITY_PROVISIONER, useExisting: GraphIngestService },
    GraphService,
    ItemRelationshipService,
    NodeService,
    ObjectIdentifierService,
    RelationshipService,
  ],
  exports: [
    EntityIdentifierService,
    GraphExpansionService,
    GraphIngestService,
    GraphService,
    ItemRelationshipService,
    NodeService,
    ObjectIdentifierService,
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
  ObjectIdentifierService,
  RelationshipService,
};
export {
  EntityIdentifierEntity,
  ItemRelationshipEntity,
  NodeEntity,
  ObjectIdentifierEntity,
  RelationshipEntity,
};
export type {
  EntityIdentifier,
  EntityIdentifierBatchEntry,
  IdentifierKey,
  ItemRelationship,
  Node,
  ObjectIdentifier,
  ObjectIdentifierBatchEntry,
  ObjectIdentifierMatch,
  ObjectIdentifierSubjectType,
  RawObjectIdentifier,
  Relationship,
};
export type {
  GraphEntityInputDto,
  GraphEntityMappingDto,
  GraphRelationshipInputDto,
  GraphIngestResult,
  ImportedEntityMatch,
  ImportedEntityRef,
  ImportedEntityRekey,
  MergedAwayEntity,
} from './services/GraphIngestService';
export type {
  ItemRelationshipInputDto,
  BulkItemRelationshipResult,
} from './services/ItemRelationshipService';
export { RelationshipMap, RelationshipType } from './types';
export {
  SINGLE_VALUED_RELATIONSHIP_TYPES,
  SYMMETRIC_RELATIONSHIP_TYPES,
  isSymmetric,
  normalizeRelationship,
  type NormalizedRelationship,
} from './relationshipNormalize';
export {
  type IdentifierKind,
  type PersonNameParts,
  PHONE_EXTENSION_PATTERN,
  classifyParticipant,
  hasPhoneExtension,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  splitPersonName,
} from './utils/normalizeIdentifier';
export {
  type NonNameParticipantReason,
  CALL_LOG_HEADING,
  isNonNameParticipant,
  nonNameParticipantReason,
  resetNonNameParticipantLog,
  stripCallLogHeading,
} from './utils/participantSanity';
export {
  type PlaceholderPersonNameReason,
  isPlaceholderPersonName,
  placeholderPersonNameReason,
  resetPlaceholderPersonNameLog,
} from './utils/placeholderPersonName';
export {
  type NormalizedObjectIdentifier,
  type ObjectIdentifierNamespace,
  computeQualifier,
  detectObjectIdentifier,
  isGloballyUniqueNamespace,
  normalizeObjectIdentifier,
} from './utils/normalizeObjectIdentifier';
export { type TruthValue, c2w, expectation, revise, w2c } from './evidence/truth';
