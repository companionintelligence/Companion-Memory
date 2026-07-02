/**
 * Agent memory domain — passive context injection for AI agents.
 *
 * Exposes REST endpoints:
 *   GET  /memory/context  — L0 static user profile (system_prompt_block)        [ApiKeyGuard]
 *   POST /memory/recall   — L1 hybrid search against the knowledge graph         [ApiKeyGuard]
 *   POST /memory/write    — ingest a raw memory fragment (on_memory_write)       [ApiKeyGuard]
 *   POST /memory/turn     — persist synced chat messages as communications       [ApiKeyGuard]
 *   POST /memory/compact  — manually trigger LLM compaction for current user     [JwtOrApiKey]
 *
 * It also publishes the CI Intent catalog (the curated, domain-separated tool surface, built from
 * the tools registered in the tools domain — every tool is an intent):
 *   GET  /api/intents          — full manifest: domains + entities + intents           [JwtOrApiKey]
 *   GET  /api/intents/domains  — the schema-domain vocabulary                          [JwtOrApiKey]
 *   GET  /api/intents/entities — the entity registry                                   [JwtOrApiKey]
 *   GET  /api/intents/:name    — a single intent by dotted name (e.g. memory.recall)   [JwtOrApiKey]
 *
 * @module AgentModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EntityResolutionModule } from '@ci/domains/entity-resolution';
import { EventsModule } from '@ci/domains/events';
import { GraphModule } from '@ci/domains/graph';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { PredictionsModule } from '@ci/domains/predictions';
import { SearchNextModule } from '@ci/domains/search-next';
import { ToolsModule } from '@ci/domains/tools';

import { IntentsController } from './controllers/IntentsController';
import { MemoryController } from './controllers/MemoryController';
import { MemoryCompactionCron } from './cron/MemoryCompactionCron';
import { AgentMemoryEntity } from './entities/AgentMemoryEntity';
import { AgentMemoryService } from './services/AgentMemoryService';
import { ForecastContextService } from './services/ForecastContextService';
import { MemoryCompactionService } from './services/MemoryCompactionService';
import { RecallService } from './services/RecallService';
import { SerializerService } from './services/SerializerService';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentMemoryEntity]),
    EntityResolutionModule,
    EventsModule,
    GraphModule,
    LLMModule,
    MemoryModule,
    PredictionsModule,
    SearchNextModule,
    // Provides IntentCatalogService, which the IntentsController publishes.
    ToolsModule,
  ],
  exports: [SerializerService],
  providers: [
    AgentMemoryService,
    ForecastContextService,
    MemoryCompactionCron,
    MemoryCompactionService,
    RecallService,
    SerializerService,
  ],
  controllers: [IntentsController, MemoryController],
})
export class AgentModule {}
