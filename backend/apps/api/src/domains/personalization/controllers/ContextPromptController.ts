import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService } from '@ci/domains/events';
import { SmartRotationWorkEvent } from '@ci/domains/smart-rotation/events';

import { ContextPromptService } from '../services/ContextPromptService';

// Mirrors SmartRotationService.workTypePriority('context_prompt') — kept as a
// literal here rather than imported since that method is private to the cron
// path; a drift between the two just means interactive requests stop cutting
// ahead of background rotation work, not a broken send.
const CONTEXT_PROMPT_WORK_PRIORITY = 5;

/**
 * The stored `response` is deliberately free-form JSON (the prompt selector
 * decides its shape), so the schema only pins the envelope: a JSON object, not
 * a bare string/array/null that would be persisted straight onto the row.
 */
export const contextPromptRespondSchema = z.object({ response: z.unknown().optional() }).strip();

@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('context-prompts')
export class ContextPromptController {
  constructor(
    private readonly contextPromptService: ContextPromptService,
    private readonly eventService: EventService,
  ) {}

  @Get('pending')
  async getPending(@Context() context: RequestContext) {
    const pending = await this.contextPromptService.getPending(context.userId!);
    if (!pending) {
      await this.enqueueGenerate(context.userId!);
    }

    return pending;
  }

  @Post(':id/respond')
  async respond(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(contextPromptRespondSchema)) body: { response?: unknown },
  ) {
    const saved = await this.contextPromptService.respond(
      toServiceContext(context),
      id,
      body.response ?? null,
    );
    if (!saved) {
      throw new NotFoundException('Context prompt not found');
    }

    await this.enqueueGenerate(context.userId!);

    return saved;
  }

  @Post(':id/skip')
  async skip(@Context() context: RequestContext, @Param('id') id: string) {
    const saved = await this.contextPromptService.skip(toServiceContext(context), id);
    if (!saved) {
      throw new NotFoundException('Context prompt not found');
    }

    await this.enqueueGenerate(context.userId!);

    return saved;
  }

  private async enqueueGenerate(userId: string): Promise<void> {
    await this.eventService.send(
      SmartRotationWorkEvent,
      { userId, workType: 'context_prompt' },
      {
        queue: 'smart-rotation',
        singletonKey: `smart-rotation:${userId}:context_prompt`,
        // Matches SmartRotationService.workTypePriority('context_prompt'). Without
        // this a human waiting here gets DEFAULT_JOB_PRIORITY (0) and sinks below
        // the cron-driven rotation work already queued at priority 5 on this
        // shared queue.
        priority: CONTEXT_PROMPT_WORK_PRIORITY,
      },
    );
  }
}
