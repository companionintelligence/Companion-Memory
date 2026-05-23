import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { GraphQueryService } from '@ci/domains/memory';
import type { RelationshipEntity } from '@ci/domains/memory';
import { SearchService } from '@ci/domains/search-next';

import type { ContextResponse, PostContextDto } from '../dto';
import type { ContextMessage } from '../entities/AgentContextLogEntity';
import { AgentContextLogEntity } from '../entities/AgentContextLogEntity';

/** Maximum number of seed entities returned from the semantic search. */
const MAX_SEED_ENTITIES = 8;

// Minimum cosine similarity (0.65) is enforced by SearchService internally
// via the pgvector index; it will become a configurable constructor parameter
// in v2.1 when the threshold is exposed via the CI agent-memory settings API.

/**
 * Approximate token budget for the injection string.
 * Matches Honcho's default ceiling to stay compatible.
 */
const MAX_INJECTION_TOKENS = 1_200;

/**
 * Very rough chars-per-token estimate (works well for English prose).
 * Used to cap injection length without a real tokeniser.
 */
const CHARS_PER_TOKEN = 4;

/** K for K-hop graph expansion (=1 means direct neighbours only). */
const K_HOP = 1;

/**
 * Agent Memory Service — MVP v1 + v2 implementation.
 *
 * **v1 path** (always runs):
 *  - Persists the incoming context batch to `ci.agent_context_log`.
 *  - Returns an empty injection string.
 *
 * **v2 path** (layered on top):
 *  - Derives a query from the last user message.
 *  - Runs a semantic search against the entity index.
 *  - Applies a cosine-similarity threshold (0.65) to filter noise.
 *  - K-hop=1 expands outgoing neighbours of the seed entities.
 *  - Formats the top-K result set as a plain-text injection string.
 *  - Respects a 1,200-token budget; truncates before returning.
 *
 * Retrieval failures are non-fatal: any error during the v2 path is logged
 * and the service falls back to returning an empty injection so the agent
 * loop is never blocked.
 */
@Injectable()
export class AgentContextService {
  constructor(
    @InjectRepository(AgentContextLogEntity)
    private readonly logRepo: Repository<AgentContextLogEntity>,
    private readonly searchService: SearchService,
    private readonly graphQueryService: GraphQueryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentContextService.name);
  }

  /**
   * Main entry point called by the controller.
   *
   * @param userId   - Resolved from the API key by the auth guard.
   * @param dto      - Validated request body.
   */
  async handleContext(userId: string, dto: PostContextDto): Promise<ContextResponse> {
    const memoryId = uuidv7();

    // ── v1: persist log row ───────────────────────────────────────────────────
    await this.persistLog(userId, dto, memoryId);

    // ── v2: semantic retrieval ────────────────────────────────────────────────
    let injection = '';
    let entitiesUsed: string[] = [];

    try {
      const result = await this.retrieveInjection(userId, dto.messages, memoryId);

      injection = result.injection;
      entitiesUsed = result.entitiesUsed;
    } catch (err) {
      this.logger.warn('Agent memory retrieval failed — returning empty injection', {
        userId,
        sessionId: dto.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { injection, memoryId, entitiesUsed };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async persistLog(userId: string, dto: PostContextDto, memoryId: string): Promise<void> {
    try {
      await this.logRepo.save(
        this.logRepo.create({
          id: memoryId,
          sessionId: dto.session_id,
          userId,
          agentId: dto.agent_id ?? null,
          turnIndex: dto.turn_index ?? null,
          messages: dto.messages as ContextMessage[],
          memoryId: null, // updated in v2 after entity ingest (future work)
        }),
      );
    } catch (err) {
      // Log but never crash — the agent loop must not be broken by a DB write.
      this.logger.error('Failed to persist agent context log row', {
        userId,
        memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * v2 retrieval path.
   *
   * 1. Extract query text from the last user message.
   * 2. Semantic search → seed entity IDs.
   * 3. K-hop=1 expansion via outgoing relationships.
   * 4. Hydrate entities and format injection string.
   */
  private async retrieveInjection(
    userId: string,
    messages: PostContextDto['messages'],
    memoryId: string,
  ): Promise<{ injection: string; entitiesUsed: string[] }> {
    const query = this.extractQuery(messages);

    if (!query) {
      return { injection: '', entitiesUsed: [] };
    }

    const context = toServiceContext({ userId });

    // Semantic search against the entity index (ci_search schema).
    const searchResults = await this.searchService.search(context, {
      query,
      mode: 'semantic',
      maxResults: MAX_SEED_ENTITIES,
    });

    if (searchResults.length === 0) {
      return { injection: '', entitiesUsed: [] };
    }

    // Extract entity IDs from search results.
    const seedIds = searchResults.map((r) => r.id);

    // Hydrate seed nodes.
    const seedNodes = await this.graphQueryService.getNodesByIds(userId, seedIds);

    if (seedNodes.length === 0) {
      return { injection: '', entitiesUsed: [] };
    }

    // K-hop=1: fetch direct outgoing relationships.
    const expandedIds = new Set<string>(seedIds);

    if (K_HOP >= 1) {
      try {
        const relationships = await this.graphQueryService.getRelationships(userId, {
          entityIds: seedIds,
          direction: 'outbound',
          includeInactive: false,
        });

        // Collect the other end of each outgoing relationship.
        for (const rel of relationships as RelationshipEntity[]) {
          if (rel.to_entity_id) {
            expandedIds.add(rel.to_entity_id);
          }
        }
      } catch (err) {
        this.logger.warn('K-hop expansion failed — using seed entities only', {
          userId,
          memoryId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Hydrate all nodes (seed + expanded).
    const allIds = Array.from(expandedIds);
    const allNodes =
      allIds.length > seedIds.length ? await this.graphQueryService.getNodesByIds(userId, allIds) : seedNodes;

    if (allNodes.length === 0) {
      return { injection: '', entitiesUsed: [] };
    }

    // Format the injection string, respecting the token budget.
    const { injection, usedIds } = this.formatInjection(allNodes, seedIds);

    return { injection, entitiesUsed: usedIds };
  }

  /**
   * Extract the best query string from the message list.
   * Uses the last user-role message; falls back to concatenating all content.
   */
  private extractQuery(messages: PostContextDto['messages']): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const last = userMessages.at(-1);

    if (last) {
      return last.content.slice(0, 512).trim();
    }

    // Fallback: join all message content (for system-prompt-only turns).
    return messages
      .map((m) => m.content)
      .join(' ')
      .slice(0, 512)
      .trim();
  }

  /**
   * Format entities into the injection string.
   *
   * Output format (matches the plan spec):
   * ```
   * Recent context — known entities:
   * - Steve Barry [p_182]: Person. brother, lives in Boston
   * - Boulder, CO [pl_44]: Place. visited frequently
   * ...
   * ```
   *
   * Seed entities appear first; expanded neighbours follow.
   * Lines are appended until the token budget is exhausted.
   */
  private formatInjection(
    nodes: Awaited<ReturnType<GraphQueryService['getNodesByIds']>>,
    seedIds: string[],
  ): { injection: string; usedIds: string[] } {
    const seedSet = new Set(seedIds);

    // Seed entities first, then expanded neighbours.
    const ordered = [
      ...nodes.filter((n) => seedSet.has(n.entity_id)),
      ...nodes.filter((n) => !seedSet.has(n.entity_id)),
    ];

    const maxChars = MAX_INJECTION_TOKENS * CHARS_PER_TOKEN;
    const header = 'Recent context — known entities:\n';
    let body = '';
    const usedIds: string[] = [];

    for (const node of ordered) {
      const name = node.name ?? 'Unknown';
      const shortId = node.entity_id.slice(0, 6);
      const type = node.entity_type ?? 'Entity';
      const desc = node.description ? `: ${node.description.slice(0, 120)}` : '';
      const line = `- ${name} [${shortId}]: ${type}${desc}\n`;

      if ((header + body + line).length > maxChars) {
        break;
      }

      body += line;
      usedIds.push(node.entity_id);
    }

    if (!body) {
      return { injection: '', usedIds: [] };
    }

    return { injection: header + body, usedIds };
  }
}
