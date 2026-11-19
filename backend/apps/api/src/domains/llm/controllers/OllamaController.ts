import {
  Body,
  ConflictException,
  Controller,
  forwardRef,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext, type UserServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard, apiKeyCapabilityOf } from '@ci/common/guards';
import type { GuardedRequest } from '@ci/common/guards/guardRequest';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { MessageService, ThreadService, type Thread } from '@ci/domains/conversations';
import { ActionService } from '@ci/domains/intelligence';
import {
  CREDENTIAL_RECHECK_MS,
  LiveChangesService,
  streamCredentialOf,
  type LiveChangesCredential,
} from '@ci/domains/live-changes';

import { isActiveGenerationStatus } from '../constants';
import { ChatGenerationBroker } from '../services/ChatGenerationBroker';
import { ChatTurnService } from '../services/ChatTurnService';
import { DESKTOP_APP_CLOSED_MESSAGE, DesktopAppService } from '../services/DesktopAppService';
import { OllamaService } from '../services/OllamaService';
import type { PromptInput } from '../types';

const promptSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  threadId: z.string().nullable().optional(),
  enableTools: z.boolean().default(true),
  enableThinking: z.boolean().default(true),
  fileIds: z.array(z.string()).optional(),
  actionId: z.string().uuid().optional(),
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
    private readonly desktopAppService: DesktopAppService,
    private readonly logger: LoggerService,
    // Same forwardRef as ChatTurnService: intelligence and llm import each other.
    @Inject(forwardRef(() => ActionService))
    private readonly actionService?: ActionService,
    @Optional() private readonly liveChanges?: LiveChangesService,
  ) {
    this.logger.setContext(OllamaController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('models')
  async listModels(@Context() context: RequestContext) {
    try {
      return await this.ollamaService.getAvailableModels(context);
    } catch (error: unknown) {
      return await this.desktopAppService.rethrow(error);
    }
  }

  /**
   * Whether Memory Desktop is closed and its model with it (see DesktopAppService.isClosed). The web app
   * polls this to say so on every page, since chat, search and summaries all stop together; an agent can
   * ask it too. `desktop: false` means this is not a desktop install and there is nothing to poll for.
   * `message` is the plain answer to pass on, null while there is nothing to say.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('desktop-app')
  async desktopAppStatus(): Promise<{ desktop: boolean; closed: boolean; message: string | null }> {
    const closed = await this.desktopAppService.isClosed();

    return {
      desktop: this.desktopAppService.isDesktop(),
      closed,
      message: closed ? DESKTOP_APP_CLOSED_MESSAGE : null,
    };
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
    @Req() req: GuardedRequest,
  ) {
    const serviceContext = toServiceContext(context);
    const ownerId = serviceContext.userId;
    const { credential } = streamCredentialOf(req);

    await this.refuseSignedOutSession(ownerId, credential);

    // The first call that needs the model. When Memory Desktop is closed and took the model with it, the
    // answer says that instead of a bare 500.
    const { model: initialModel } = await this.ollamaService
      .resolveModel(context, { requestedModel: input.model })
      .catch((error: unknown) => this.desktopAppService.rethrow(error));

    let thread: Thread;

    if (input.threadId != null) {
      const maybeThread = await this.threadService.findById(serviceContext, input.threadId);

      if (maybeThread == null) {
        throw new NotFoundException();
      }

      thread = maybeThread;
    } else {
      thread = await this.startThread(serviceContext, initialModel, input.actionId);
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
      credential,
    });

    this.broker.pipeToResponse(res, thread.id);
    // The key or session that asked is revoked: the turn stops the way Stop stops it, which ends this
    // response with the part that streamed. The worker watches the same credential for as long as the
    // turn runs, open response or not (ChatTurnService.execute); this covers a turn still in the queue.
    this.watchResponse(res, ownerId, credential, () => this.broker.abort(thread.id));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('threads/:threadId/stream')
  async stream(
    @Context() context: RequestContext,
    @Param('threadId') threadId: string,
    @Res() res: Response,
    @Req() req: GuardedRequest,
  ) {
    const serviceContext = toServiceContext(context);
    const { credential } = streamCredentialOf(req);

    await this.refuseSignedOutSession(serviceContext.userId, credential);

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
    // Only this viewer: someone may watch a turn another of their devices asked for. That turn
    // answers to the credential that asked for it.
    this.watchResponse(res, serviceContext.userId, credential, () => res.end());
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

  /**
   * 401 for a bearer whose session was signed out. The guard checked the token's signature and expiry,
   * not the session behind it, so a tab signed out elsewhere could start or watch a reply until its
   * token ran out. The live-update stream refuses it the same way.
   */
  private async refuseSignedOutSession(userId: string, credential: LiveChangesCredential): Promise<void> {
    if (credential.kind !== 'session' || !this.liveChanges) {
      return;
    }

    if (!(await this.liveChanges.isCredentialLive(userId, credential))) {
      throw new UnauthorizedException();
    }
  }

  /**
   * Run `onRevoked` once the key or session this response was asked with stops letting its user in
   * (deleted, signed out, the account deleted), for as long as the response is open. A revoke notice
   * checks at once; the timer covers what sends none.
   *
   * A client that left during the awaits before this has had its `close` already. Listeners added
   * now hear neither `close` nor `finish`, so a watch on it ran its timer and its lookups until the
   * credential went, or for good on a key. The generate one then aborted whatever turn held the
   * thread by that time. A token with no session has nothing to look up.
   *
   * The watch stops on `finish`, which waits for a slow client to drain what was written. Between
   * `end()` and then, the thread may already hold a turn someone else asked for, so a response that
   * has ended does nothing.
   */
  private watchResponse(
    res: Response,
    userId: string,
    credential: LiveChangesCredential,
    onRevoked: () => void,
  ): void {
    if (!this.liveChanges || credential.kind === 'token' || res.writableEnded || res.destroyed) {
      return;
    }

    const watch = this.liveChanges.watchCredential(
      userId,
      credential,
      () => {
        if (!res.writableEnded) {
          onRevoked();
        }
      },
      CREDENTIAL_RECHECK_MS,
    );

    res.on('close', watch.stop);
    res.on('finish', watch.stop);
  }

  /**
   * A new thread for a turn that has none yet.
   *
   * From the Today action window the turn is ABOUT an action, and the action
   * derived by an engine (Confirm home, a metric suggestion) has no thread of
   * its own. Starting a bare thread lost that: the model saw "Why do you
   * suggest this?" with nothing before it, and the action never pointed at the
   * thread, so a reload showed the bare action again. So the thread opens with
   * the action's own text as the assistant's first message (what the window
   * already shows as the first bubble), takes the action's title, and the
   * action is linked to it. An action that already has a thread is continued;
   * one whose thread was archived is relinked to the new one, or every visit
   * would start another thread the action never points at.
   */
  private async startThread(
    context: UserServiceContext,
    model: string,
    actionId: string | undefined,
  ): Promise<Thread> {
    const action =
      actionId && this.actionService ? await this.actionService.findById(context, actionId) : null;

    if (action?.threadId) {
      const existing = await this.threadService.findById(context, action.threadId);

      if (existing) {
        return existing;
      }
    }

    const thread = await this.threadService.create(context, {
      model,
      ...(action?.title ? { name: action.title } : {}),
    });

    if (action && this.actionService) {
      if (action.text?.trim()) {
        await this.messageService.create(context, {
          model,
          role: 'assistant',
          content: action.text,
          mimetype: 'text/markdown',
          canceled: false,
          threadId: thread.id,
        });
      }

      await this.actionService.attachThread(context, action.id, thread.id, action.threadId ?? null);
    }

    return thread;
  }
}
