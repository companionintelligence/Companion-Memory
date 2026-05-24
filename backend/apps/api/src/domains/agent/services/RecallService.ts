import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ConceptService, GraphUtilityService, UserContextService } from '@ci/domains/memory';
import { SearchService } from '@ci/domains/search-next';

import type { ContextResult, RecallDto, RecallResult, ToolCallDto, ToolResult } from '../types';

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_QUERY_MAX_RESULTS = 10;
// Approx token budget: each node snippet ~40 tokens, cap total injected context
const MAX_BLOCK_CHARS = 3000;

@Injectable()
export class RecallService {
  constructor(
    private readonly userContextService: UserContextService,
    private readonly searchService: SearchService,
    private readonly graphUtility: GraphUtilityService,
    private readonly conceptService: ConceptService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RecallService.name);
  }

  // ---------------------------------------------------------------------------
  // L0 — static user profile (for system_prompt_block)
  // ---------------------------------------------------------------------------

  async getL0Context(context: UserServiceContext): Promise<ContextResult> {
    try {
      const userCtx = await this.userContextService.getUserContextForLLM(context.userId);

      if (!userCtx) {
        return { block: '' };
      }

      const lines: string[] = ['# About You'];

      lines.push(`**Name**: ${userCtx.currentUser.name}`);
      if (userCtx.currentUser.username) {
        lines.push(`**Username**: ${userCtx.currentUser.username}`);
      }

      if (userCtx.currentUser.dossier?.summary) {
        lines.push(`\n${userCtx.currentUser.dossier.summary}`);
      }

      if (userCtx.familyMembers.length > 0) {
        lines.push('\n## Close Relationships');
        for (const member of userCtx.familyMembers) {
          const age = member.age ? `, age ${member.age}` : '';
          lines.push(`- **${member.name}** (${member.relationship}${age})`);
        }
      }

      const likes = userCtx.topPreferences.filter((p) => p.relationship === 'PREFERS');
      const dislikes = userCtx.topPreferences.filter((p) => p.relationship === 'DISLIKES');

      if (likes.length > 0) {
        lines.push('\n## Preferences');
        lines.push(
          `**Likes**: ${likes
            .slice(0, 8)
            .map((p) => p.name)
            .join(', ')}`,
        );
      }

      if (dislikes.length > 0) {
        if (likes.length === 0) {
          lines.push('\n## Preferences');
        }

        lines.push(
          `**Dislikes**: ${dislikes
            .slice(0, 5)
            .map((p) => p.name)
            .join(', ')}`,
        );
      }

      lines.push(
        `\n## Knowledge Graph\n${userCtx.quickStats.totalEntities} entities tracked across people, places, events, and more.`,
      );

      return { block: lines.join('\n') };
    } catch (err) {
      this.logger.warn(`L0 context failed for user ${context.userId}: ${err}`);

      return { block: '' };
    }
  }

  // ---------------------------------------------------------------------------
  // L1 — dynamic semantic search (for prefetch)
  // ---------------------------------------------------------------------------

  async recall(context: UserServiceContext, dto: RecallDto): Promise<RecallResult> {
    const maxResults = dto.maxResults ?? DEFAULT_MAX_RESULTS;

    try {
      const searchResults = await this.searchService.search(context, {
        query: dto.query,
        mode: 'auto',
        maxResults,
      });

      if (searchResults.length === 0) {
        return { block: '', resultCount: 0 };
      }

      const ids = searchResults.map((r) => r.id);
      const nodes = await this.graphUtility.getNodesByIds(ids, context.userId);

      const lines: string[] = ['## From your knowledge graph'];
      let chars = 0;

      for (const node of nodes) {
        const snippet = this.formatNode(node);
        if (chars + snippet.length > MAX_BLOCK_CHARS) {
          break;
        }

        lines.push(snippet);
        chars += snippet.length;
      }

      if (lines.length <= 1) {
        return { block: '', resultCount: 0 };
      }

      return { block: lines.join('\n'), resultCount: nodes.length };
    } catch (err) {
      this.logger.warn(`Recall failed for user ${context.userId}: ${err}`);

      return { block: '', resultCount: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool dispatch
  // ---------------------------------------------------------------------------

  async handleToolCall(context: UserServiceContext, dto: ToolCallDto): Promise<ToolResult> {
    switch (dto.tool) {
      case 'ci_search':
        return this.toolSearch(context, dto.args);
      case 'ci_query':
        return this.toolQuery(context, dto.args);
      case 'ci_remember':
        return this.toolRemember(context, dto.args);
      default:
        return { result: { error: `Unknown tool: ${dto.tool}` } };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async toolSearch(context: UserServiceContext, args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args['query'] ?? '');
    const maxResults = Math.min(Number(args['maxResults'] ?? DEFAULT_MAX_RESULTS), 20);

    if (!query) {
      return { result: { error: 'query is required' } };
    }

    const { block, resultCount } = await this.recall(context, { query, maxResults });

    return { result: { memories: block, count: resultCount } };
  }

  private async toolQuery(context: UserServiceContext, args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args['query'] ?? '');
    const entityType = args['entityType'] as string | undefined;
    const maxResults = Math.min(Number(args['maxResults'] ?? DEFAULT_QUERY_MAX_RESULTS), 20);

    if (!query) {
      return { result: { error: 'query is required' } };
    }

    try {
      const searchOptions: Parameters<typeof this.searchService.search>[1] = {
        query,
        mode: 'hybrid',
        maxResults,
      };

      if (entityType) {
        (searchOptions as { includeTypes?: string[] }).includeTypes = [entityType];
      }

      const searchResults = await this.searchService.search(context, searchOptions as never);
      const ids = searchResults.map((r) => r.id);
      const nodes = await this.graphUtility.getNodesByIds(ids, context.userId);

      const results = nodes.map((node) => ({
        id: node.entity_id,
        type: node.entity_type,
        name: node.name,
        description: node.description,
        properties: node.properties,
      }));

      return { result: { results, count: results.length } };
    } catch (err) {
      this.logger.warn(`ci_query failed: ${err}`);

      return { result: { error: 'Query failed', details: String(err) } };
    }
  }

  private async toolRemember(
    context: UserServiceContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const content = String(args['content'] ?? '');
    const name = args['name'] ? String(args['name']) : undefined;

    if (!content) {
      return { result: { error: 'content is required' } };
    }

    try {
      await this.conceptService.create(context, {
        name: name ?? content.slice(0, 80),
        description: content,
        searchContent: content,
      });

      return { result: { stored: true } };
    } catch (err) {
      this.logger.warn(`ci_remember failed: ${err}`);

      return { result: { error: 'Failed to store memory', details: String(err) } };
    }
  }

  private formatNode(node: {
    entity_type: string;
    name: string | null;
    description: string | null;
    search_content: string | null;
    properties: Record<string, unknown>;
  }): string {
    const type = node.entity_type;
    const name = node.name ?? '(unnamed)';
    const detail =
      node.description ??
      node.search_content?.slice(0, 120) ??
      Object.entries(node.properties)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') ??
      '';

    return `- **${name}** (${type})${detail ? `: ${detail}` : ''}`;
  }
}
