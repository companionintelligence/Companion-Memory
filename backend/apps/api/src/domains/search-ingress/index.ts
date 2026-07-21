/**
 * This module consumes entity creation, update, and removal events and
 * maintains an eventually consistent search index.
 *
 * @module SearchIngressModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';
import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { ParsingModule } from '@ci/domains/parsing';

import { EmbeddingEntity } from './entities/EmbeddingEntity';
import { IndexSkipEntity } from './entities/IndexSkipEntity';
import { VectorEntity } from './entities/VectorEntity';
import { AnswerSearchIndexListener } from './listeners/AnswerSearchIndexListener';
import { BrowserActivitySearchIndexListener } from './listeners/BrowserActivitySearchIndexListener';
import { CommunicationSearchIndexListener } from './listeners/CommunicationSearchIndexListener';
import { ConceptSearchIndexListener } from './listeners/ConceptSearchIndexListener';
import { ContentSearchIndexListener } from './listeners/ContentSearchIndexListener';
import { EntityEmbeddingListener } from './listeners/EntityEmbeddingListener';
import { EventSearchIndexListener } from './listeners/EventSearchIndexListener';
import { FileChunkSearchIndexListener } from './listeners/FileChunkSearchIndexListener';
import { FileSearchIndexListener } from './listeners/FileSearchIndexListener';
import { ItemSearchIndexListener } from './listeners/ItemSearchIndexListener';
import { MessageSearchIndexListener } from './listeners/MessageSearchIndexListener';
import { NoteSearchIndexListener } from './listeners/NoteSearchIndexListener';
import { PersonSearchIndexListener } from './listeners/PersonSearchIndexListener';
import { PlaceSearchIndexListener } from './listeners/PlaceSearchIndexListener';
import { ThreadSearchIndexListener } from './listeners/ThreadSearchIndexListener';
import { EmbeddingService } from './services/EmbeddingService';
import { IndexSkipService } from './services/IndexSkipService';
import { OrphanCleanupService } from './services/OrphanCleanupService';
import { VectorService } from './services/VectorService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EmbeddingEntity, IndexSkipEntity, VectorEntity]),
    BrowserActivityModule,
    ConversationModule,
    EmbeddingModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    ParsingModule,
  ],
  providers: [
    AnswerSearchIndexListener,
    BrowserActivitySearchIndexListener,
    CommunicationSearchIndexListener,
    ConceptSearchIndexListener,
    ContentSearchIndexListener,
    EmbeddingService,
    EntityEmbeddingListener,
    EventSearchIndexListener,
    FileChunkSearchIndexListener,
    FileSearchIndexListener,
    IndexSkipService,
    ItemSearchIndexListener,
    MessageSearchIndexListener,
    NoteSearchIndexListener,
    OrphanCleanupService,
    PersonSearchIndexListener,
    PlaceSearchIndexListener,
    ThreadSearchIndexListener,
    VectorService,
  ],
  exports: [OrphanCleanupService],
})
export class SearchIngressModule {}

export { EmbeddingEntity, IndexSkipEntity, VectorEntity };
export { OrphanCleanupService, SEARCH_TABLES } from './services/OrphanCleanupService';
export type {
  OrphanCleanupOptions,
  OrphanCleanupResult,
  OrphanTypeResult,
  TruncateSearchIndexResult,
} from './services/OrphanCleanupService';
export { ENTITY_SOURCE_MAP } from './entitySourceMap';
export type { EntitySource } from './entitySourceMap';
