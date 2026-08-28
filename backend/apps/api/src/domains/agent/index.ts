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
 * the tools registered in the tools domain — every tool is an intent). Same routes
 * also mount at `/api/agent/intents` (canonical for Hermes / OpenClaw):
 *   GET  /api/intents          — full manifest: domains + entities + intents           [JwtOrApiKey]
 *   GET  /api/intents/domains  — the schema-domain vocabulary                          [JwtOrApiKey]
 *   GET  /api/intents/entities — the entity registry                                   [JwtOrApiKey]
 *   GET  /api/intents/:name    — a single intent by dotted name (e.g. memory.recall)   [JwtOrApiKey]
 *   POST /api/intents/:name/execute — run the intent via ToolRegistry (raw JSON body)  [JwtOrApiKey]
 *
 * @module AgentModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MessageEntity } from '@ci/domains/conversations';
import { EntityResolutionModule } from '@ci/domains/entity-resolution';
import { EventsModule } from '@ci/domains/events';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { PredictionsModule } from '@ci/domains/predictions';
import { RetrievalPolicyModule } from '@ci/domains/retrieval-policy';
import { SearchNextModule } from '@ci/domains/search-next';
import { ToolsModule } from '@ci/domains/tools';
import { UserModule } from '@ci/domains/user';

import { IntentsController } from './controllers/IntentsController';
import { MemoryController } from './controllers/MemoryController';
import { AgentMemoryRetentionCron } from './cron/AgentMemoryRetentionCron';
import { MemoryCompactionCron } from './cron/MemoryCompactionCron';
import { TurnFragmentCron } from './cron/TurnFragmentCron';
import { AgentMemoryEntity } from './entities/AgentMemoryEntity';
import { TurnFragmentListener } from './listeners/TurnFragmentListener';
import { AgentMemoryRetentionService } from './services/AgentMemoryRetentionService';
import { AgentMemoryService } from './services/AgentMemoryService';
import { BranchialForecastService } from './services/BranchialForecastService';
import { ForageCorpusService } from './services/ForageCorpusService';
import { ForecastContextService } from './services/ForecastContextService';
import { MemoryCompactionService } from './services/MemoryCompactionService';
import { RecallService } from './services/RecallService';
import { SerializerService } from './services/SerializerService';
import { TurnFragmentService } from './services/TurnFragmentService';

@Module({
  imports: [
    // MessageEntity comes in as a repository rather than by importing
    // ConversationModule: TurnFragmentService only reads chat rows, and the
    // agent domain already depends on LLMModule, which depends on
    // conversations — a module import here would close that circle.
    TypeOrmModule.forFeature([AgentMemoryEntity, MessageEntity]),
    EntityResolutionModule,
    EventsModule,
    GraphModule,
    // ActionService, for the retention sweep's stuck-pipeline card. IntelligenceModule
    // imports only TypeOrmModule + EventsModule, so this adds no cycle back here.
    IntelligenceModule,
    LLMModule,
    MemoryModule,
    PredictionsModule,
    // RecallService's five retrieval knobs come from ci.retrieval_policy.
    RetrievalPolicyModule,
    SearchNextModule,
    // Provides IntentCatalogService, which the IntentsController publishes.
    ToolsModule,
    UserModule,
  ],
  exports: [
    SerializerService,
    ForecastContextService,
    RecallService,
    BranchialForecastService,
    ForageCorpusService,
  ],
  providers: [
    AgentMemoryRetentionCron,
    AgentMemoryRetentionService,
    AgentMemoryService,
    BranchialForecastService,
    ForageCorpusService,
    ForecastContextService,
    MemoryCompactionCron,
    MemoryCompactionService,
    RecallService,
    SerializerService,
    TurnFragmentCron,
    TurnFragmentListener,
    TurnFragmentService,
  ],
  controllers: [IntentsController, MemoryController],
})
export class AgentModule {}

export { BranchialForecastService, ForageCorpusService, ForecastContextService, RecallService };
export type { RecallOptions } from './services/RecallService';
export type { EvidenceVoice, RecallLine, RecallObjectRef, RecallObjectType, RecallResult } from './types';
export type {
  BranchialBranch,
  BranchialPermutation,
  BranchialStep,
  BranchialTree,
} from './services/branchialOccupancy';
