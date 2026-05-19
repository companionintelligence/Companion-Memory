import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { LoggerService } from '@ci/common/logging';
import { UserContextService } from '@ci/domains/memory';

interface ApiKeyAuthMarker {
  scopes: string[];
  keyId: string;
  actorId: string;
}

/**
 * Plan 01 §4.1 — registers MCP prompts. A prompt is "load this context
 * before reasoning"; agents call `prompts/get` to receive a ready-made
 * system message they can drop into their loop. The twin's dossier surface
 * (UserContextService) is the perfect source.
 *
 * Today the catalog ships one prompt:
 *  - `ci.user-context` — the full dossier.
 *
 * Follow-ups add `ci.recent-activity(window)`, `ci.routine-for(day)`,
 * `ci.relationships(scope)`, and `ci.summary(date|range)` once their
 * source services are stable.
 */
@Injectable()
export class McpPromptService {
  constructor(
    private readonly userContext: UserContextService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpPromptService.name);
  }

  /**
   * Register every catalog prompt on the given MCP server. The request is
   * captured so the prompt callback can resolve the caller's userId from
   * either the JWT (`req.user`) or the API-key marker (`req.apiKeyAuth`).
   */
  register(server: McpServer, req: Request): void {
    server.registerPrompt(
      'ci.user-context',
      {
        title: 'CI user context',
        description: 'Load the current owner dossier: preferences, family, top relationships, and traits.',
      },
      async () => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: await this.renderUserContext(req),
            },
          },
        ],
      }),
    );

    this.logger.log('MCP prompts registered', { count: 1 });
  }

  /**
   * Pull the dossier via UserContextService and render it as a single
   * system-prompt-friendly text block. Returns a stub when no context is
   * available (e.g. fresh Hub with no entities) so the prompt is still
   * usable, just less informed.
   */
  private async renderUserContext(req: Request): Promise<string> {
    const userId = this.callerUserId(req);
    if (!userId) {
      return 'No authenticated user; load a fresh session before calling ci.user-context.';
    }

    const ctx = await this.userContext.getUserContextForLLM(userId);
    if (!ctx) {
      return `No knowledge graph context available for user ${userId}.`;
    }

    const lines: string[] = [];
    lines.push(`You are talking with ${ctx.currentUser.name}.`);

    if (ctx.currentUser.dossier?.summary) {
      lines.push('', `Dossier: ${ctx.currentUser.dossier.summary}`);
    }

    if (ctx.currentUser.dossier?.tone) {
      lines.push(`Tone: ${ctx.currentUser.dossier.tone}`);
    }

    const traits = ctx.currentUser.dossier?.personalityTraits ?? [];
    if (traits.length) {
      lines.push(`Personality traits: ${traits.join(', ')}`);
    }

    const guidelines = ctx.currentUser.dossier?.interactionGuidelines ?? [];
    if (guidelines.length) {
      lines.push('Interaction guidelines:');
      for (const g of guidelines) {
        lines.push(`  - ${g}`);
      }
    }

    if (ctx.familyMembers.length) {
      lines.push('', 'Family:');
      for (const f of ctx.familyMembers) {
        lines.push(`  - ${f.name} (${f.relationship}${f.age != null ? `, age ${f.age}` : ''})`);
      }
    }

    if (ctx.topPreferences.length) {
      const likes = ctx.topPreferences.filter((p) => p.relationship === 'PREFERS').slice(0, 8);
      const dislikes = ctx.topPreferences.filter((p) => p.relationship === 'DISLIKES').slice(0, 5);

      if (likes.length) {
        lines.push('', 'Top preferences:');
        for (const p of likes) {
          lines.push(`  - ${p.name} (${p.type})`);
        }
      }

      if (dislikes.length) {
        lines.push('', 'Known dislikes:');
        for (const p of dislikes) {
          lines.push(`  - ${p.name} (${p.type})`);
        }
      }
    }

    return lines.join('\n');
  }

  private callerUserId(req: Request): string | undefined {
    const user = (req as { user?: { id?: string } }).user;
    if (user?.id) {
      return user.id;
    }

    const apiKeyAuth = (req as { apiKeyAuth?: ApiKeyAuthMarker }).apiKeyAuth;

    return apiKeyAuth?.actorId;
  }
}
