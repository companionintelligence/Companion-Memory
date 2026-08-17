import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { EventService } from '@ci/domains/events';
import { SmartRotationWorkEvent } from '@ci/domains/smart-rotation/events';

import { ContextPromptService } from '../services/ContextPromptService';

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
    @Body() body: { response?: unknown },
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
      { queue: 'smart-rotation', singletonKey: `smart-rotation:${userId}:context_prompt` },
    );
  }
}
