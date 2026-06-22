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

import { type Node, NodeEntity } from './entities/NodeEntity';
import { type Relationship, RelationshipEntity } from './entities/RelationshipEntity';
import { GraphExpansionService } from './services/GraphExpansionService';
import { GraphIngestService } from './services/GraphIngestService';
import { GraphService } from './services/GraphService';
import { NodeService } from './services/NodeService';
import { RelationshipService } from './services/RelationshipService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([NodeEntity, RelationshipEntity]),
    ConversationModule,
    EmbeddingModule,
    EventsModule,
    MemoryModule,
    NotesModule,
    UserModule,
  ],
  providers: [GraphExpansionService, GraphIngestService, GraphService, NodeService, RelationshipService],
  exports: [GraphExpansionService, GraphIngestService, GraphService, NodeService, RelationshipService],
})
export class GraphModule {}

export { GraphExpansionService, GraphIngestService, GraphService, NodeService, RelationshipService };
export { NodeEntity, RelationshipEntity };
export type { Node, Relationship };
export { RelationshipMap, RelationshipType } from './types';
