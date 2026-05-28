import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { ApiKeyGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';

import { RecallService } from '../services/RecallService';
import { recallSchema, type RecallDto } from '../types';

@Controller('memory')
export class MemoryController {
  constructor(
    private readonly recallService: RecallService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Semantic search against the knowledge graph.
   *
   * Invoked by:
   *   - OpenClaw 'assemble'
   *   - Hermes 'prefetch'
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
   * Ingests a conversation into the database.
   *
   * Invoked by
   *   - OpenClaw 'afterTurn'
   *   - Hermes 'sync_turn'
   */
  @UseGuards(ApiKeyGuard)
  @Post('turn')
  async turn(/* @Context() context: RequestContext, @Body(new ValidationPipe(turnSchema)) input: TurnDto */) {
    // Right now we're just using this to sync Hermes and OpenClaw messages to
    // sync to our system. We would store these as threads and messages (probably).
    //
    // Ultimately we would be interested in syncing context when a turn happens.
    //
    // threadService.upsert(sessionId)
    // messageService.create(userMessage)
    // messageService.create(assistantMessage)
    //
    // As a result of creating a thread and / or messages, we already emit events internally.
    //
    // All of the asynchronous processing downstream of these events can be handled in event listeners.
    //
    // What we return from this message gets injected into the agent message before it goes into the agent.
    // Note that the respones are not SSE, so any latency that we are incurring gets passed to the user.
    // So we might think about how to partition the immediate results (sync) and the gradual improvements to our
    // responses (async).
  }

  /**
   * We don't know how we're going to use this yet, so we're leaving it as a
   * no-op route.
   *
   * Invoked by:
   *   - OpenClaw 'memory_store'
   *   - Hermes 'on_memory_write'
   */
  // @UseGuards(ApiKeyGuard)
  // @Post('persist')
  // async persist() { }
}
