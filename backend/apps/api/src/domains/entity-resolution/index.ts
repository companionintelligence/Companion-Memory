/**
 * Resolves lightweight search-index identifiers (`{ type, id }`) into full
 * domain entities. Consumers use this instead of duplicating the batch-fetch
 * logic across resolvers and services.
 *
 * @module EntityResolutionModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule, ReceiptEntity } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { ParsingModule } from '@ci/domains/parsing';

import { EntityResolutionService } from './services/EntityResolutionService';

@Module({
  imports: [
    // Owned by the memory domain; registered here so the resolver can batch-read
    // receipts by id — see the note on the injected repository.
    TypeOrmModule.forFeature([ReceiptEntity]),
    BrowserActivityModule,
    ConversationModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    ParsingModule,
  ],
  providers: [EntityResolutionService],
  exports: [EntityResolutionService],
})
export class EntityResolutionModule {}

export { EntityResolutionService } from './services/EntityResolutionService';
export type { ResolvedEntity } from './services/EntityResolutionService';
