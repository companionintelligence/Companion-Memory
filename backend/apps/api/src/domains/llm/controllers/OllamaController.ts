import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard, type ApiKeyScopedRequest, apiKeyCapabilityOf } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { MessageService, ThreadService, type Thread } from '@ci/domains/conversations';

import { isActiveGenerationStatus } from '../constants';
import { ChatGenerationBroker } from '../services/ChatGenerationBroker';
import { ChatTurnService } from '../services/ChatTurnService';
import { OllamaService } from '../services/OllamaService';
import type { PromptInput } from '../types';

const promptSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  threadId: z.string().nullable().optional(),
  enableTools: z.boolean().default(true),
  enableThinking: z.boolean().default(true),
  fileIds: z.array(z.string()).optional(),
});
const modelCapabilitiesSchema = z.object({
  model: z.string().min(1),
});

@Controller('llm')
export class OllamaController {
  constructor(
    private readonly messageService: MessageService,
    private readonly ollamaService: OllamaService,
    private readonly threadService: ThreadService,
    private readonly broker: ChatGenerationBroker,
    private readonly chatTurnService: ChatTurnService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OllamaController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('models')
  async listModels(@Context() context: RequestContext) {
    return await this.ollamaService.getAvailableModels(context);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('models/capabilities')
  async getModelCapabilities(
    @Context() context: RequestContext,
    @Query(new ValidationPipe(modelCapabilitiesSchema)) query: z.infer<typeof modelCapabilitiesSchema>,
  ) {
    const capabilities = await this.ollamaService.getModelCapabilities(context, query.model);

    return {
      model: query.model,
      capabilities,
      vision: capabilities.includes('vision'),
    };
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('generate')
  @HttpCode(200)
  // Chat is reachable by a read key on purpose: the key's capability is handed to the
  // tool layer (see `capability: apiKeyCapabilityOf(req)` below), which is what decides
  // whether any tool the model reaches for may write. Without this the shape rule would
  // turn every read-only chat key away at the door instead.
  @RequireCapability(READ_CAPABILITY)
  async generate(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(promptSchema)) input: PromptInput,
    @Res() res: Response,
    @Req() req: ApiKeyScopedRequest,
  ) {
    const serviceContext = toServiceContext(context);
    const ownerId = serviceContext.userId;

    const { model: initialModel } = await this.ollamaService.resolveModel(context, {
      requestedModel: input.model,
    });

    let thread: Thread;

    if (input.threadId != null) {
      const maybeThread = await this.threadService.findById(serviceContext, input.threadId);

      if (maybeThread == null) {
        throw new NotFoundException();
      }

      thread = maybeThread;
    } else {
      thread = await this.threadService.create(serviceContext, {
        model: initialModel,
      });
    }

    if (isActiveGenerationStatus(thread.generationStatus)) {
      throw new ConflictException('This thread is already generating a reply');
    }

    const promptMessage = await this.messageService.create(serviceContext, {
      model: initialModel,
      role: 'user',
      content: input.prompt,
      mimetype: 'text/markdown',
      canceled: false,
      threadId: thread.id,
      fileIds: input.fileIds,
    });

    const assistantMessage = await this.messageService.create(serviceContext, {
      model: initialModel,
      role: 'assistant',
      content: '',
      mimetype: 'text/markdown',
      canceled: false,
      threadId: thread.id,
      promptMessageId: promptMessage.id,
    });

    await this.chatTurnService.setGenerationStatus(serviceContext, thread.id, 'queued');
    this.broker.ensure(thread.id);

    await this.chatTurnService.enqueueGenerate({
      ownerId,
      threadId: thread.id,
      promptMessageId: promptMessage.id,
      assistantMessageId: assistantMessage.id,
      model: initialModel,
      enableTools: input.enableTools ?? true,
      enableThinking: input.enableThinking ?? true,
      capability: apiKeyCapabilityOf(req),
    });

    this.broker.pipeToResponse(res, thread.id);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('threads/:threadId/stream')
  async stream(
    @Context() context: RequestContext,
    @Param('threadId') threadId: string,
    @Res() res: Response,
  ) {
    const serviceContext = toServiceContext(context);
    const thread = await this.threadService.findById(serviceContext, threadId);

    if (thread == null) {
      throw new NotFoundException();
    }

    if (!isActiveGenerationStatus(thread.generationStatus) && !this.broker.has(threadId)) {
      res.status(204).end();

      return;
    }

    this.broker.ensure(threadId);
    this.broker.pipeToResponse(res, threadId);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('threads/:threadId/cancel')
  @HttpCode(204)
  // Stopping one's own generation is the read key's to do too.
  @RequireCapability(READ_CAPABILITY)
  async cancel(@Context() context: RequestContext, @Param('threadId') threadId: string) {
    const serviceContext = toServiceContext(context);
    const thread = await this.threadService.findById(serviceContext, threadId);

    if (thread == null) {
      throw new NotFoundException();
    }

    this.broker.abort(threadId);

    if (isActiveGenerationStatus(thread.generationStatus)) {
      await this.chatTurnService.setGenerationStatus(serviceContext, threadId, 'idle');
    }
  }
}
