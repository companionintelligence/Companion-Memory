/**
 * Exposes CI's entity graph and semantic search as a memory provider for
 * external agents (Hermes Agent, OpenClaw).
 *
 * ### Key Components:
 * - **AgentContextController**: `POST /v1/memory/context` — receives paused-agent
 *   context from the Hermes `sync_turn` / OpenClaw `agent_end` hooks.
 * - **AgentContextService**: Persists each context batch to `ci.agent_context_log`
 *   (v1) and performs semantic retrieval + K-hop graph expansion to build an
 *   injection string (v2).
 * - **AgentContextLogEntity**: The TypeORM entity backing `ci.agent_context_log`.
 *
 * ### Auth:
 * API-key via `X-CI-API-Key` header, scoped to `agent_memory:write`.
 * Post-install scripts (Ermy) provision the key automatically.
 *
 * @module AgentMemoryModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MemoryModule } from '@ci/domains/memory';
import { SearchNextModule } from '@ci/domains/search-next';

import { AgentContextController } from './controllers/AgentContextController';
import { AgentContextLogEntity } from './entities/AgentContextLogEntity';
import { AgentContextService } from './services/AgentContextService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentContextLogEntity]), SearchNextModule, MemoryModule],
  providers: [AgentContextService],
  controllers: [AgentContextController],
  exports: [AgentContextService],
})
export class AgentMemoryModule {}

export { AgentContextLogEntity, AgentContextService };
export type { ContextMessage } from './entities/AgentContextLogEntity';
export type { ContextResponse, PostContextDto } from './dto';
