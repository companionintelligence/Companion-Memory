import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { Scopes, ScopesGuard, SCOPES } from '@ci/common/scopes';

import { PostContextDto } from '../dto';
import { AgentContextService } from '../services/AgentContextService';

/**
 * Memory-provider REST surface for external agents (Hermes / OpenClaw).
 *
 * All routes live under `/v1/memory` so they can be proxied through a
 * dedicated `agents.ci-domain` subdomain without touching the main SPA routes.
 *
 * Auth: API-key only (`X-CI-API-Key` header), scope `agent_memory:write`.
 * JWT is also accepted so CI's own clients can call the endpoint in tests.
 *
 * MVP v1 — POST returns a minimal JSON response even though the Hermes plugin
 * only checks for a non-error status code. The response body is stable so v2
 * can return a richer injection string without breaking the plugin contract.
 */
@UseGuards(JwtOrApiKeyAuthGuard, ScopesGuard)
@Controller('v1/memory')
export class AgentContextController {
  constructor(private readonly agentContextService: AgentContextService) {}

  /**
   * Receives a paused-agent context snapshot from Hermes or OpenClaw.
   *
   * **v1 behaviour:** Logs the context and returns an empty injection string.
   *   The Hermes `sync_turn` hook fires this in a daemon thread so latency
   *   does not affect the user's response — but we still target < 200ms p99.
   *
   * **v2 behaviour (same endpoint):** Embeds the last user message, runs a
   *   semantic search on the entity index, performs K-hop=1 expansion, and
   *   returns a formatted injection string that the `prefetch` hook can
   *   prepend to the system prompt.
   *
   * Returns HTTP 200 with `{injection, memoryId, entitiesUsed}` in both
   * versions so the Hermes plugin can be upgraded without changing the plugin
   * contract check.
   */
  @Post('context')
  @HttpCode(HttpStatus.OK)
  @Scopes(SCOPES.AGENT_MEMORY_WRITE)
  async postContext(@Body() dto: PostContextDto, @Context() context: RequestContext) {
    const { userId } = toServiceContext(context);

    return this.agentContextService.handleContext(userId, dto);
  }
}
