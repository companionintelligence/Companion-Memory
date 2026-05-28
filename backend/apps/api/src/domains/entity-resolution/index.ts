/**
 * Resolves lightweight search-index identifiers (`{ type, id }`) into full
 * domain entities. Consumers use this instead of duplicating the batch-fetch
 * logic across resolvers and services.
 *
 * @module EntityResolutionModule
 */

import { Module } from '@nestjs/common';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';

import { EntityResolutionService } from './services/EntityResolutionService';

@Module({
  imports: [
    BrowserActivityModule,
    ConversationModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
  ],
  providers: [EntityResolutionService],
  exports: [EntityResolutionService],
})
export class EntityResolutionModule {}

export { EntityResolutionService } from './services/EntityResolutionService';
export type { ResolvedEntity } from './services/EntityResolutionService';
