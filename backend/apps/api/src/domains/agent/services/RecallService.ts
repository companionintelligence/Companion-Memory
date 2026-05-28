import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SearchService } from '@ci/domains/search-next';

import type { RecallDto, RecallResult } from '../types';

const DEFAULT_MAX_RESULTS = 5;

@Injectable()
export class RecallService {
  constructor(
    private readonly searchService: SearchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RecallService.name);
  }

  async recall(context: UserServiceContext, dto: RecallDto): Promise<RecallResult> {
    const maxResults = dto.maxResults ?? DEFAULT_MAX_RESULTS;
    const keywords = this.sanitizeQuery(dto.query);

    if (!keywords) {
      return { block: '', resultCount: 0 };
    }

    try {
      const results = await this.searchService.search(context, {
        query: keywords,
        mode: 'keyword',
        maxResults,
      });

      if (results.length === 0) {
        return { block: '', resultCount: 0 };
      }

      // TODO: hydrate entity names/descriptions from the graph and format richer snippets.
      // For now we return type + id so the skeleton is structurally correct.
      const lines = ['## Relevant context'];
      for (const result of results) {
        lines.push(`- ${result.type} · ${result.id}`);
      }

      return {
        block: lines.join('\n'),
        resultCount: results.length,
      };
    } catch (err) {
      this.logger.warn(`Recall failed for user ${context.userId}: ${err}`);

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
   * This is NOT keyword extraction — stop-word removal and stemming are
   * delegated entirely to Postgres. A future improvement would extract named
   * entities / noun phrases here before handing off to search.
   */
  private sanitizeQuery(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
