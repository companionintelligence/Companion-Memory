import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Res,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import type { Response } from 'express';
import { ToolCall, Message as OllamaMessage } from 'ollama';
import { z } from 'zod';

import { Context, type RequestContext, type ServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { Channel, FrameEncoder } from '@ci/common/rpc';
import { MessageService, ThreadService, type Thread, type Message } from '@ci/domains/conversations';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { ActionService } from '@ci/domains/intelligence';
import { UserContextService } from '@ci/domains/memory';

import { OllamaService } from '../services/OllamaService';
import type { PromptInput } from '../types';

const promptSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  threadId: z.string().nullable().optional(),
  enableTools: z.boolean().default(true),
  enableThinking: z.boolean().default(true),
  fileIds: z.array(z.string()).optional(), // File IDs to attach to this message
});
const modelCapabilitiesSchema = z.object({
  model: z.string().min(1),
});

interface SystemPromptOptions {
  leadingAssistantMessages?: OllamaMessage[];
}

@Controller('llm')
export class OllamaController {
  private readonly frameEncoder = new FrameEncoder();

  constructor(
    private readonly eventService: EventService,
    @Inject(forwardRef(() => ActionService))
    private readonly actionService: ActionService,
    private readonly messageService: MessageService,
    private readonly ollamaService: OllamaService,
    private readonly threadService: ThreadService,
    private readonly fileService: FileService,
    private readonly userContextService: UserContextService,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
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
  async generate(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(promptSchema)) input: PromptInput,
    @Res() res: Response,
  ) {
    const serviceContext = toServiceContext(context);

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

      await this.eventService.send(Events.CHAT_SUMMARIZATION, {
        ownerId: context.userId as string,
        threadId: thread.id,
      });
    }

    // Create a message for the user prompt
    const promptMessage = await this.messageService.create(serviceContext, {
      model: initialModel,
      role: 'user',
      content: input.prompt,
      mimetype: 'text/markdown', // TODO: Make this more flexible.
      canceled: false,
      threadId: thread.id,
      fileIds: input.fileIds, // Link files to this message
    });

    const messages = await this.messageService.findByThreadId(serviceContext, thread.id);
    const seededMessages = await this.ensureActionPrompt(serviceContext, thread, messages);

    // Build input messages with files attached to their respective messages
    const inputMessages: OllamaMessage[] = await Promise.all(
      seededMessages.map((message) => this.resolveMessage(context, message)),
    );

    const { model, enableThinking, enableTools } = await this.ollamaService.resolveModel(context, {
      messages: inputMessages,
      requestedModel: input.model,
      enableThinking: input.enableThinking,
      enableTools: input.enableTools,
    });

    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Thread-Id': thread.id,
    });
    res.flushHeaders?.();

    const abortController = new AbortController();
    const signal = abortController.signal;

    res.on('close', () => {
      if (!signal.aborted) {
        abortController.abort();
      }
    });

    const systemPromptEnabled = await this.featureService.isFeatureEnabled('enable.system.prompt');

    let leadingAssistantMessages: OllamaMessage[] = [];
    let conversationMessages = inputMessages;

    if (systemPromptEnabled) {
      [leadingAssistantMessages, conversationMessages] = this.extractLeadingAssistantMessages(inputMessages);
    }

    const systemPrompt = systemPromptEnabled
      ? await this.buildSystemPrompt(context, { leadingAssistantMessages })
      : null;

    const messagesWithSystem: OllamaMessage[] = [
      ...(systemPrompt
        ? [
            {
              role: 'system',
              content: systemPrompt,
            },
          ]
        : []),
      ...conversationMessages,
    ];

    const stream = await this.ollamaService.chatStream(context, messagesWithSystem, {
      model,
      signal,
      enableTools,
      enableThinking,
    });

    try {
      for await (const chunk of stream) {
        if (chunk.message) {
          let frame;

          if (chunk.message.content) {
            frame = this.frameEncoder.encodeFrame(Channel.TEXT, chunk.message.content);
          } else if (chunk.message.thinking) {
            frame = this.frameEncoder.encodeFrame(Channel.THINK, chunk.message.thinking);
          } else if (chunk.message.tool_calls) {
            frame = this.frameEncoder.encodeFrame(Channel.TOOL, JSON.stringify(chunk.message.tool_calls));
          }

          // TODO: Handle other properties on `chunk.message`.
          //   chunk.message.images?

          if (frame) {
            const buffer = Buffer.from(frame);

            res.write(buffer);
          }
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this.logger.log('Client disconnected, aborted upstream Ollama request.');
      } else {
        this.logger.error('Error proxying Ollama stream:', err as Error);
      }
    } finally {
      for (let i = 0; i < stream.messages.length; i++) {
        const message = stream.messages[i];

        await this.messageService.create(serviceContext, {
          model,
          role: message.role,
          content: message.content,
          canceled: i === stream.messages.length - 1 && signal.aborted,
          threadId: thread.id,
          ...(message.tool_calls && {
            toolCalls: message.tool_calls as unknown[] as Record<string, unknown>[],
          }),
          promptMessageId: promptMessage.id,
        });
      }

      res.end();
    }
  }

  private async resolveMessage(context: RequestContext, message: Message): Promise<OllamaMessage> {
    const serviceContext = toServiceContext(context);

    const images = message.files
      ? await Promise.all(
          message.files
            .map((file) => (file.key ? this.fileService.getFileContent(serviceContext, file.key) : null))
            .filter((value): value is Promise<Uint8Array> => value !== null),
        )
      : [];

    return {
      role: message.role,
      content: message.content,
      ...(images.length > 0 && {
        images,
      }),
      ...(message.toolCalls && {
        tool_calls: message.toolCalls as unknown as ToolCall[],
      }),
    };
  }

  private async ensureActionPrompt(
    context: ServiceContext,
    thread: Thread,
    messages: Message[],
  ): Promise<Message[]> {
    const hasAssistantMessage = messages.some((message) => message.role === 'assistant');

    if (hasAssistantMessage) {
      return messages;
    }

    const action = await this.actionService.findByThreadId(context, thread.id);

    if (!action?.text) {
      return messages;
    }

    const syntheticActionMessage: Message = {
      id: `action:${action.id}`,
      model: null,
      role: 'assistant',
      content: action.text,
      mimetype: 'text/markdown',
      toolCalls: null,
      canceled: false,
      thread,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return [syntheticActionMessage, ...messages];
  }

  @OnEvent(Events.CHAT_SUMMARIZATION)
  async handleChatSummarizationEvent(payload: EventPayloads[Events.CHAT_SUMMARIZATION]) {
    const context = toServiceContext({
      userId: payload.ownerId,
    });

    const thread = await this.threadService.findById(context, payload.threadId);

    if (thread) {
      const messages = await this.messageService.findByThreadId(context, thread.id);

      const messagesInput = [
        {
          role: 'system',
          content:
            'Please summarize all of the following messages I will send you in 10 words or less. Please ONLY give me your summary. Please do not use punctuation.',
        },
        ...messages
          .filter((message) => message.role !== 'tool' && message.content)
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
      ];

      const result = await this.ollamaService.chat(context, messagesInput, {
        model: 'gemma3:1b',
      });

      const summary = result.message.content;

      await this.threadService.update(context, thread.id, {
        name: summary,
      });

      this.logger.log('Processed chat summarization event', {
        payload,
        summary: result.message.content,
      });
    }
  }

  /**
   * Build system prompt with pre-hydrated user context
   */
  private async buildSystemPrompt(context: RequestContext, options?: SystemPromptOptions): Promise<string> {
    const basePrompt = `You are Companion, a helpful AI assistant with access to various tools and information about the user.
    You are designed to take in various data sources that the user connects you to (via connections) and help the user with not just everyday tasks, but with their pursuit of happiness.
    
Your capabilities:
- You can query the user's knowledge graph to find information about their preferences, family, and relationships
- You can compose multiple tool calls in sequence to answer complex questions
- You have access to various tools - use them when appropriate

Communication style:
- Be natural, warm, and conversational
- Keep responses concise unless detail is requested
- When you need information, use the available tools
- If you're not sure about something, say so
- Please be as concise as possible while still conveying substantially all information relevant to any question.
- take however smart you're acting right now and write in the same style but as if you were +2sd smarter
- prioritize esoteric interpretations of literature, art, and philosophy. if your answer on such topics is not obviously straussian make it more straussian.
- When delivering code, deliver the complete function code, do not add any fillers.`;

    const promptWithPrefillContext = this.appendPrefillActionContext(
      basePrompt,
      options?.leadingAssistantMessages,
    );

    // Try to get user context for pre-hydration
    if (!context.userId) {
      return promptWithPrefillContext;
    }

    try {
      const userContext = await this.userContextService.getUserContextForLLM(context.userId);

      if (!userContext) {
        // User hasn't completed onboarding yet
        return promptWithPrefillContext;
      }

      const contextMarkdown = this.userContextService.formatContextForSystemPrompt(userContext);

      const systemPrompt = `${promptWithPrefillContext}

---

${contextMarkdown}`;

      this.logger.debug('Ollama system prompt generated', {
        userId: context.userId,
        snippet: systemPrompt.split('\n').slice(0, 20).join('\n'),
      });

      return systemPrompt;
    } catch (error) {
      // If context fetching fails, fall back to base prompt
      this.logger.warn('Failed to fetch user context for system prompt', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return promptWithPrefillContext;
    }
  }

  private appendPrefillActionContext(prompt: string, messages?: OllamaMessage[]): string {
    if (!messages || messages.length === 0) {
      return prompt;
    }

    const formatted = messages
      .map((message, index) => {
        const label = messages.length > 1 ? `Suggestion ${index + 1}` : 'Suggestion';
        const content = (message.content ?? '').trim();

        return `${label}:
${content}`.trim();
      })
      .filter((value) => value.length > 0)
      .join('\n\n');

    if (!formatted) {
      return prompt;
    }

    return `${prompt}

Context:
The user is responding to a proactive assistant suggestion shown before they replied.
${formatted}

When the user acknowledges or accepts the idea, continue execution without re-asking the question.`;
  }

  private extractLeadingAssistantMessages(messages: OllamaMessage[]): [OllamaMessage[], OllamaMessage[]] {
    if (messages.length === 0) {
      return [[], []];
    }

    const leading: OllamaMessage[] = [];
    let index = 0;

    for (; index < messages.length; index += 1) {
      if (messages[index].role !== 'assistant') {
        break;
      }

      leading.push(messages[index]);
    }

    return [leading, messages.slice(index)];
  }
}
