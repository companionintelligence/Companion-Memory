import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { MemoryModule } from '@ci/domains/memory';
import { TemporalClientService } from '@ci/temporal/temporal-client.service';

import { TemporalService } from './services/TemporalService';

/**
 * Temporal module for coordinating with Temporal workflows.
 *
 * Provides services to manage LLM resource priority by pausing/resuming
 * background summarization workflows when high-priority user-facing operations
 * need immediate access.
 *
 * Also provides TemporalClientService for starting and executing workflows
 * in the same process as the API.
 *
 * @module TemporalModule
 */
@Module({
  imports: [ConversationModule, FilesModule, MemoryModule],
  providers: [TemporalService, TemporalClientService],
  exports: [TemporalService, TemporalClientService],
})
export class TemporalModule {}
