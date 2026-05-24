/**
 * Agent memory domain — passive context injection for AI agents.
 *
 * Exposes four REST endpoints (all behind ApiKeyGuard):
 *   GET  /agent/context  — L0 static user profile (system prompt block)
 *   POST /agent/recall   — L1 semantic search against the knowledge graph
 *   POST /agent/absorb   — async ingestion of a conversation turn (202)
 *   POST /agent/tools    — explicit tool dispatch (ci_search, ci_query, ci_remember)
 *
 * Designed to back a Hermes MemoryProvider plugin that injects memories
 * passively without the agent needing to invoke MCP tools.
 *
 * @module AgentModule
 */

import { Module } from '@nestjs/common';

import { MemoryModule } from '@ci/domains/memory';
import { SearchNextModule } from '@ci/domains/search-next';

import { AgentContextController } from './controllers/AgentContextController';
import { AbsorbService } from './services/AbsorbService';
import { RecallService } from './services/RecallService';

@Module({
  imports: [MemoryModule, SearchNextModule],
  providers: [RecallService, AbsorbService],
  controllers: [AgentContextController],
})
export class AgentModule {}

export { CI_TOOL_SCHEMAS } from './types';
