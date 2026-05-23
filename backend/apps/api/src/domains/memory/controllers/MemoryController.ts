import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { GraphEventService } from '../services/GraphEventService';
import { GraphQueryService } from '../services/GraphQueryService';
import { GraphUtilityService } from '../services/GraphUtilityService';
import { UserContextService } from '../services/UserContextService';

const rememberSchema = z.object({
  content: z.string().min(1).max(16384),
  name: z.string().min(1).max(255).optional(),
  entityType: z.string().min(1).max(64).default('Concept'),
  tags: z.array(z.string().min(1)).max(32).optional(),
  metadata: z.record(z.unknown()).optional(),
  source: z.string().min(1).max(255).optional(),
});

const recallSchema = z.object({
  query: z.string().min(1).max(1024),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  entityType: z.string().min(1).max(64).optional(),
});

const listSchema = z.object({
  entityType: z.string().min(1).max(64).optional(),
  nameContains: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const forgetBodySchema = z
  .object({
    reason: z.string().min(1).max(512).optional(),
    hardDelete: z.boolean().optional(),
  })
  .default({});

// Matches any RFC 4122 UUID (v1–v8). We accept all versions because the
// underlying graph services mint v7 IDs via `uuidv7()`, while legacy rows
// may still carry v4 ids. Nest's built-in `ParseUUIDPipe` defaults to v4
// only and would 400 the remember→forget round-trip for newly minted ids.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RememberDto = z.infer<typeof rememberSchema>;
type RecallDto = z.infer<typeof recallSchema>;
type ListDto = z.infer<typeof listSchema>;
type ForgetDto = z.infer<typeof forgetBodySchema>;

/**
 * Universal memory-provider surface for external integrations (MCP servers,
 * Hermes plugins, OpenClaw skills). Wraps the underlying knowledge graph
 * services with a small, opinionated remember/recall/forget API so that
 * adapters in other ecosystems do not need to model the full entity graph.
 *
 * Authenticated via the standard `x-api-key` header (or a session JWT).
 */
@Controller('memory')
@UseGuards(JwtOrApiKeyAuthGuard)
export class MemoryController {
  constructor(
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
    private readonly graphUtility: GraphUtilityService,
    private readonly userContext: UserContextService,
  ) {}

  private ensureUserId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new BadRequestException('Authenticated user context is required');
    }

    return ctx.userId;
  }

  @Post('remember')
  async remember(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(rememberSchema)) input: RememberDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const tags = input.tags ?? [];
    const metadata = input.metadata ?? {};

    const properties: Record<string, unknown> = {
      ...metadata,
      tags,
    };
    if (input.source) {
      properties.source = input.source;
    }

    const name = input.name ?? this.deriveNameFromContent(input.content);

    const { entityId } = await this.graphEvents.upsertNode(ownerId, {
      entityType: input.entityType,
      name,
      description: input.content,
      properties,
      searchContent: input.content,
    });

    return {
      success: true,
      memory: {
        id: entityId,
        entityType: input.entityType,
        name,
        content: input.content,
        tags,
        metadata,
      },
    };
  }

  @Get('recall')
  async recall(@Context() ctx: RequestContext, @Query(new ValidationPipe(recallSchema)) query: RecallDto) {
    const ownerId = this.ensureUserId(ctx);
    const trimmed = query.query.trim();
    const limit = query.limit;

    const textMatches = await this.graphQuery.searchNodesByText(ownerId, trimmed, { limit });
    const prefixMatches = await this.graphQuery.searchNodesByPrefix(ownerId, trimmed, { limit });

    type Match = {
      entityId: string;
      score: number | null;
      entityType: string;
      name: string | null;
      description: string | null;
      properties: Record<string, unknown>;
    };
    const merged: Match[] = [];
    const seen = new Set<string>();

    const accept = (
      candidate: {
        entity_id: string;
        entity_type: string;
        name: string | null;
        description: string | null;
        properties: Record<string, unknown> | null;
      },
      score: number | null,
    ) => {
      if (seen.has(candidate.entity_id) || merged.length >= limit) {
        return;
      }

      if (query.entityType && candidate.entity_type !== query.entityType) {
        return;
      }

      seen.add(candidate.entity_id);
      merged.push({
        entityId: candidate.entity_id,
        score,
        entityType: candidate.entity_type,
        name: candidate.name,
        description: candidate.description,
        properties: candidate.properties ?? {},
      });
    };

    for (const candidate of prefixMatches) {
      accept(candidate, null);
    }

    for (const candidate of textMatches) {
      accept(candidate.node, candidate.score);
    }

    return {
      success: true,
      query: trimmed,
      results: merged.map((match) => ({
        id: match.entityId,
        entityType: match.entityType,
        name: match.name,
        content: match.description,
        score: match.score,
        tags: this.extractTags(match.properties),
        metadata: this.extractMetadata(match.properties),
      })),
    };
  }

  @Get('list')
  async list(@Context() ctx: RequestContext, @Query(new ValidationPipe(listSchema)) query: ListDto) {
    const ownerId = this.ensureUserId(ctx);

    const nodes = await this.graphQuery.getNodes(ownerId, {
      entityType: query.entityType,
      nameContains: query.nameContains,
      limit: query.limit,
    });

    return {
      success: true,
      results: nodes.map((node) => ({
        id: node.entity_id,
        entityType: node.entity_type,
        name: node.name,
        content: node.description,
        tags: this.extractTags(node.properties ?? {}),
        metadata: this.extractMetadata(node.properties ?? {}),
        createdAt: node.created_at?.toISOString?.() ?? null,
        updatedAt: node.updated_at?.toISOString?.() ?? null,
      })),
    };
  }

  @Delete('forget/:id')
  @HttpCode(HttpStatus.OK)
  async forget(
    @Context() ctx: RequestContext,
    @Param('id') entityId: string,
    @Body(new ValidationPipe(forgetBodySchema)) body: ForgetDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    if (!UUID_PATTERN.test(entityId)) {
      throw new BadRequestException('id must be a UUID');
    }

    const node = await this.graphQuery.getNode(ownerId, entityId);
    if (!node) {
      throw new NotFoundException(`Memory ${entityId} not found`);
    }

    const hardDelete = body.hardDelete === true;
    const affected = await this.graphUtility.deactivateEntities([entityId], ownerId, hardDelete);

    return {
      success: true,
      forgotten: affected > 0,
      id: entityId,
      mode: hardDelete ? 'hard' : 'archive',
      reason: body.reason ?? null,
    };
  }

  @Get('context')
  async context(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(ownerId);

    return {
      success: true,
      context,
    };
  }

  @Get('health')
  async health() {
    return {
      success: true,
      service: 'companion-memory',
      time: new Date().toISOString(),
    };
  }

  private deriveNameFromContent(content: string): string {
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (firstLine.length === 0) {
      return 'memory';
    }

    if (firstLine.length <= 80) {
      return firstLine;
    }

    return `${firstLine.slice(0, 77)}...`;
  }

  private extractTags(properties: Record<string, unknown>): string[] {
    const raw = properties.tags;
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === 'string');
    }

    return [];
  }

  private extractMetadata(properties: Record<string, unknown>): Record<string, unknown> {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'tags') {
        continue;
      }

      rest[key] = value;
    }

    return rest;
  }
}
