/**
 * Agent memory domain — passive context injection for AI agents.
 *
 * Exposes REST endpoints:
 *   GET  /memory/context  — L0 static user profile (system_prompt_block)        [ApiKeyGuard]
 *   POST /memory/recall   — L1 hybrid search against the knowledge graph         [ApiKeyGuard]
 *   POST /memory/note     — ingest a raw memory fragment (on_memory_write)       [ApiKeyGuard]
 *   POST /memory/turn     — stub for conversation ingestion                      [ApiKeyGuard]
 *   GET  /memory/notes    — list recent fragments for the settings UI            [JwtOrApiKey]
 *   POST /memory/compact  — manually trigger LLM compaction for current user     [JwtOrApiKey]
 *
 * @module AgentModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmbeddingModule } from '@ci/common/embeddings';
import { EntityResolutionModule } from '@ci/domains/entity-resolution';
import { GraphModule } from '@ci/domains/graph';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { SearchNextModule } from '@ci/domains/search-next';

import { MemoryController } from './controllers/MemoryController';
import { MemoryCompactionCron } from './cron/MemoryCompactionCron';
import { AgentMemoryEntity } from './entities/AgentMemoryEntity';
import { AgentMemoryService } from './services/AgentMemoryService';
import { GraphExpansionService } from './services/GraphExpansionService';
import { MemoryCompactionService } from './services/MemoryCompactionService';
import { RecallService } from './services/RecallService';
import { SerializerService } from './services/SerializerService';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentMemoryEntity]),
    EmbeddingModule,
    EntityResolutionModule,
    GraphModule,
    LLMModule,
    MemoryModule,
    SearchNextModule,
  ],
  exports: [SerializerService],
  providers: [
    AgentMemoryService,
    GraphExpansionService,
    MemoryCompactionCron,
    MemoryCompactionService,
    RecallService,
    SerializerService,
  ],
  controllers: [MemoryController],
})
export class AgentModule {}
