import { createHash } from 'crypto';

import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { ApiKeyGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { CommunicationService, CommunicationType, UserContextService } from '@ci/domains/memory';

import { AgentMemoryService } from '../services/AgentMemoryService';
import { ForecastContextService } from '../services/ForecastContextService';
import { MemoryCompactionService } from '../services/MemoryCompactionService';
import { RecallService } from '../services/RecallService';
import {
  agentMemorySchema,
  recallSchema,
  turnSchema,
  type AgentMemoryDto,
  type RecallDto,
  type TurnDto,
} from '../types';

const TURN_MESSAGE_CATEGORY = 'agent-turn';

function createAgentTurnMessageId(input: {
  userId: string;
  platform: string;
  sessionId?: string;
  role: 'user' | 'assistant';
  content: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // UUID v8 uses custom deterministic bytes while preserving UUID shape.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join(
    '-',
  );
}

@Controller('memory')
export class MemoryController {
  constructor(
    private readonly userContextService: UserContextService,
    private readonly recallService: RecallService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly communicationService: CommunicationService,
    private readonly forecastContextService: ForecastContextService,
    private readonly compactionService: MemoryCompactionService,
    private readonly logger: LoggerService,
  ) {
    logger.setContext(MemoryController.name);
  }

  /**
   * L0 — static user profile block for the agent system prompt.
   *
   * Returns a pre-formatted markdown block summarising the user's knowledge
   * graph: name, relationships, preferences, and dossier. Intended to be
   * called once per session (system_prompt_block), not per turn.
   */
  @UseGuards(ApiKeyGuard)
  @Get('context')
  async context(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    try {
      const userCtx = await this.userContextService.getUserContextForLLM(serviceContext.userId);
      const blocks: string[] = [];

      if (userCtx) {
        blocks.push(this.userContextService.formatContextForSystemPrompt(userCtx));
      }

      const forecastBlock = await this.forecastContextService.getRestOfDayBlock(serviceContext);
      if (forecastBlock) {
        blocks.push(forecastBlock);
      }

      return { block: blocks.join('\n\n') };
    } catch (err) {
      this.logger.warn(`L0 context failed for user ${context.userId}: ${err}`);

      return { block: '' };
    }
  }

  /**
   * L1 — per-turn hybrid search against the knowledge graph.
   *
   * Runs a keyword/semantic search using the query, then hydrates matched
   * entity IDs into readable names and content.
   */
  @UseGuards(ApiKeyGuard)
  @Post('recall')
  async recall(@Context() context: RequestContext, @Body(new ValidationPipe(recallSchema)) input: RecallDto) {
    return this.recallService.recall(toServiceContext(context), {
      query: input.query,
      maxResults: input.maxResults,
    });
  }

  /**
   * Stores a raw memory fragment written by the agent or by Hermes's built-in
   * memory system (on_memory_write hook).  The fragment is saved verbatim to
   * ci.agent_memory; the compaction cron promotes it into the knowledge graph.
   *
   * Invoked by:
   *   - Hermes 'on_memory_write'
   */
  @UseGuards(ApiKeyGuard)
  @HttpCode(201)
  @Post('write')
  async write(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(agentMemorySchema)) input: AgentMemoryDto,
  ) {
    return this.agentMemoryService.create(toServiceContext(context), input);
  }

  /**
   * Ingests a conversation turn into the database.
   *
   * Invoked by:
   *   - OpenClaw 'afterTurn'
   *   - Hermes 'sync_turn'
   */
  @UseGuards(ApiKeyGuard)
  @HttpCode(201)
  @Post('turn')
  async turn(@Context() context: RequestContext, @Body(new ValidationPipe(turnSchema)) input: TurnDto) {
    const serviceContext = toServiceContext(context);
    const sessionId = input.sessionId?.trim();
    const platform = input.platform?.trim() || 'agent';
    const persistableMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      input.messages.flatMap((message) =>
        (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0
          ? [{ role: message.role, content: message.content }]
          : [],
      );
    let created = 0;
    let skipped = 0;

    for (const message of persistableMessages) {
      const content = message.content.trim();
      const id = createAgentTurnMessageId({
        userId: serviceContext.userId,
        platform,
        sessionId,
        role: message.role,
        content,
      });
      const [existing] = await this.communicationService.findByIds(serviceContext, [id]);

      if (existing) {
        skipped += 1;
        continue;
      }

      await this.communicationService.create(serviceContext, {
        id,
        time: new Date(Date.now() + created),
        communication_type: CommunicationType.CHAT,
        direction: message.role === 'user' ? 'inbound' : 'outbound',
        thread_id: sessionId,
        participants_metadata: {
          platform,
          role: message.role,
          sessionId,
        },
        subject: `${platform} conversation`,
        content,
        preview: content.slice(0, 240),
        category: TURN_MESSAGE_CATEGORY,
      });
      created += 1;
    }

    skipped += input.messages.length - persistableMessages.length;

    return { created, skipped };
  }

  // ---------------------------------------------------------------------------
  // Settings UI endpoints (JWT or API key — usable from the browser)
  // ---------------------------------------------------------------------------

  /**
   * Manually triggers the memory compaction worker for the current user's
   * unprocessed fragments.  The LLM call runs in the background; the response
   * returns immediately with the number of queued fragments.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @HttpCode(200)
  @Post('compact')
  async compact(@Context() context: RequestContext) {
    const userId = context.userId;

    if (!userId) {
      return { queued: 0 };
    }

    // minAgeMinutes: 0 — bypass the settling delay used by the cron.
    // When a user explicitly triggers compaction they want it to process
    // everything immediately, regardless of how recently the fragments were
    // written.
    // limit 1000 — a manual trigger means "process everything now"; the cron
    // path keeps a smaller batch, but here we don't want a backlog to be
    // silently truncated (e.g. a large bulk import of 100s of fragments).
    const unprocessed = await this.agentMemoryService.findUnprocessed(toServiceContext(context), {
      limit: 1000,
      minAgeMinutes: 0,
    });

    if (unprocessed.length === 0) {
      return { queued: 0 };
    }

    void this.compactionService
      .compactForUser({ userId }, unprocessed)
      .catch((err: unknown) =>
        this.logger.error('Manual compaction failed', err instanceof Error ? err : new Error(String(err))),
      );

    return { queued: unprocessed.length };
  }
}
