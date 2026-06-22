import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EntityResolutionService } from '@ci/domains/entity-resolution';
import { GraphExpansionService } from '@ci/domains/graph';
import { SearchService } from '@ci/domains/search-next';

import type { RecallDto, RecallResult } from '../types';

import { AgentMemoryService } from './AgentMemoryService';
import { SerializerService } from './SerializerService';

const DEFAULT_MAX_RESULTS = 5;

// Raw-message ("naive RAG") channel: how many source fragments to vector-search
// and union into the recall block alongside the graph nodes + expansion. Full
// union, no cap on the merge — tuning showed capping/re-ranking only hurts.
const MESSAGE_RESULTS = 10;

/**
 * L1 — per-turn keyword/semantic search against the knowledge graph.
 *
 * Runs SearchService in 'auto' mode (keyword for short queries, boosted for
 * medium, semantic for long), resolves the returned identifiers into full
 * domain entities via EntityResolutionService, serialises them into compact
 * single-line strings, then expands one query-relevant hop through the graph
 * (GraphExpansionService) so relational questions ("where does X live?") can
 * reach the answer node that sits one edge away from the search hit.
 */
@Injectable()
export class RecallService {
  constructor(
    private readonly searchService: SearchService,
    private readonly entityResolution: EntityResolutionService,
    private readonly serializer: SerializerService,
    private readonly graphExpansion: GraphExpansionService,
    private readonly agentMemory: AgentMemoryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RecallService.name);
  }

  async recall(context: UserServiceContext, dto: RecallDto): Promise<RecallResult> {
    const maxResults = dto.maxResults ?? DEFAULT_MAX_RESULTS;
    const query = this.sanitizeQuery(dto.query);

    if (!query) {
      return { block: '', resultCount: 0 };
    }

    try {
      // 'boosted' (keyword match + embedding boost, OR-joined) is the most
      // reliable seed finder for entity-centric KG queries — short or long.
      // 'auto' routes 8+ word questions ("What does Jordan's brother do for
      // work?") to pure semantic search, which frequently returns nothing and
      // leaves graph expansion with no seed to expand from. Fall back to
      // semantic only when boosted is empty (genuinely paraphrased queries).
      let results = await this.searchService.search(context, {
        query,
        mode: 'boosted',
        maxResults,
        excludeTypes: ['message'],
      });

      if (results.length === 0) {
        results = await this.searchService.search(context, {
          query,
          mode: 'semantic',
          maxResults,
          excludeTypes: ['message'],
        });
      }

      if (results.length === 0) {
        return { block: '', resultCount: 0 };
      }

      const resolved = await this.entityResolution.resolve(context, results);

      const lines: string[] = [];
      const includedIds = new Set<string>();

      // Preserve the original search-score ordering.
      for (const { type, id } of results) {
        const hit = resolved.get(`${type}:${id}`);

        if (!hit) {
          continue;
        }

        const line = this.serializer.serialize(hit);

        if (line) {
          lines.push(line);
          includedIds.add(id);
        }
      }

      if (lines.length === 0) {
        return { block: '', resultCount: 0 };
      }

      // Expand one query-relevant hop. Seeds are the search hits; their ids are
      // ci.entities entity_ids (item/content/event are indexed under the
      // 'concept' tag but keep their real id). Neighbours already shown as
      // seeds are excluded so we never duplicate a line.
      const seedIds = results.map((r) => r.id);
      const neighbours = await this.graphExpansion.expand(context, seedIds, query, includedIds);

      for (const neighbour of neighbours) {
        if (includedIds.has(neighbour.entityId)) {
          continue;
        }

        lines.push(neighbour.line);
        includedIds.add(neighbour.entityId);
      }

      // Naive-RAG channel. The graph lines above are terse, lossy serialisations
      // ("Priya Sharma — lives in Phoenix"); the source sentences carry detail
      // the extraction dropped ("moved from Eugene last spring, lives with her
      // husband Arjun"). Vector-search the raw messages and union their text in.
      // Use the original (unsanitised) query — natural language embeds better.
      try {
        const messageHits = await this.searchService.searchMessages(context, dto.query, MESSAGE_RESULTS);

        if (messageHits.length > 0) {
          const memories = await this.agentMemory.findByIds(
            context,
            messageHits.map((hit) => hit.id),
          );
          const contentById = new Map(memories.map((memory) => [memory.id, memory.content]));
          const seenText = new Set(lines);

          for (const hit of messageHits) {
            const text = contentById.get(hit.id)?.trim();

            if (text && !seenText.has(text)) {
              lines.push(text);
              seenText.add(text);
            }
          }
        }
      } catch (err) {
        // The graph result still stands if the message channel fails.
        this.logger.warn('Message-channel retrieval failed', {
          userId: context.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const block = `## Relevant context\n${lines.join('\n')}`;

      return { block, resultCount: lines.length };
    } catch (err) {
      this.logger.warn('Recall failed', {
        userId: context.userId,
        error: err instanceof Error ? err.message : String(err),
      });

      return { block: '', resultCount: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Strips punctuation and normalises whitespace so the query works cleanly
   * with Postgres websearch_to_tsquery.
   *
   * NOT keyword extraction — stop-word removal and stemming are delegated
   * entirely to Postgres.
   */
  private sanitizeQuery(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
