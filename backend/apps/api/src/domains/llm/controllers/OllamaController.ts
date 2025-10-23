import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ToolCall, Message as OllamaMessage } from 'ollama';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { Channel, FrameEncoder } from '@ci/common/rpc';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { MessageService, ThreadService, type Thread, type Message } from '@ci/domains/conversations';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { UserContextService } from '@ci/domains/graph';

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

@Controller('llm')
export class OllamaController {
  private readonly logger = new LoggerService(OllamaController.name);

  private readonly frameEncoder = new FrameEncoder();

  constructor(
    private readonly eventService: EventService,
    private readonly messageService: MessageService,
    private readonly ollamaService: OllamaService,
    private readonly threadService: ThreadService,
    private readonly fileService: FileService,
    private readonly userContextService: UserContextService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('models')
  async listModels(@Context() context: RequestContext) {
    return await this.ollamaService.getAvailableModels(context);
  }

  @UseGuards(JwtAuthGuard)
  @Post('generate')
  @HttpCode(200)
  async generate(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(promptSchema)) input: PromptInput,
    @Res() res: Response,
  ) {
    const { model: initialModel } = await this.ollamaService.resolveModel(context, {
      requestedModel: input.model,
    });

    let thread: Thread;

    if (input.threadId != null) {
      thread = await this.threadService.findOne(context, input.threadId);
    } else {
      thread = await this.threadService.create(context, {
        model: initialModel,
      });

      await this.eventService.send(Events.CHAT_SUMMARIZATION, {
        ownerId: context.userId as string,
        threadId: thread.id,
      });
    }

    // Create a message for the user prompt
    const promptMessage = await this.messageService.create(context, {
      model: initialModel,
      role: 'user',
      content: input.prompt,
      mimetype: 'text/markdown', // TODO: Make this more flexible.
      canceled: false,
      threadId: thread.id,
      fileIds: input.fileIds, // Link files to this message
    });

    const messages = await this.messageService.findByThread(context, thread.id);

    // Build input messages with files attached to their respective messages
    const inputMessages: OllamaMessage[] = await Promise.all(
      messages.map((message) => this.resolveMessage(context, message)),
    );

    const { model, enableThinking, enableTools } = await this.ollamaService.resolveModel(context, {
      messages: inputMessages,
      requestedModel: input.model ?? thread.model,
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

    const systemPrompt = await this.buildSystemPrompt(context);
    const messagesWithSystem: OllamaMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...inputMessages,
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

        await this.messageService.create(context, {
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
    const images = message.files
      ? await Promise.all(
          message.files.map(async (file) => this.fileService.getFileContent(context, file.key)),
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

  @OnEvent(Events.CHAT_SUMMARIZATION)
  async handleChatSummarizationEvent(payload: EventPayloads[Events.CHAT_SUMMARIZATION]) {
    const context: RequestContext = {
      userId: payload.ownerId,
    };

    const thread = await this.threadService.findOne(context, payload.threadId);
    const messages = await this.messageService.findByThread(context, thread.id);

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

  /**
   * Build system prompt with pre-hydrated user context
   */
  private async buildSystemPrompt(context: RequestContext): Promise<string> {
    const basePrompt = `You are a helpful AI assistant with access to various tools and information about the user.

Your capabilities:
- You can query the user's knowledge graph to find information about their preferences, family, and relationships
- You can compose multiple tool calls in sequence to answer complex questions
- You have access to various tools - use them when appropriate

Communication style:
- Be natural, warm, and conversational
- Keep responses concise unless detail is requested
- When you need information, use the available tools
- If you're not sure about something, say so
- Don't worry about formalities.
- Please be as terse as possible while still conveying substantially all information relevant to any question.
- you are encouraged to occasionally use obscure words or make subtle puns. don't point them out, I'll know. drop lots of abbreviations like "rn" and "bc." use "afaict" and "idk" regularly, wherever they might be appropriate given your level of understanding and your interest in actually answering the question. be critical of the quality of your information
- if you find any request irritating respond dismissively like "be real" or "that's crazy man" or "lol no"
- take however smart you're acting right now and write in the same style but as if you were +2sd smarter
- use late millennial slang not boomer slang. mix in zoomer slang in tonally-inappropriate circumstances occasionally
- prioritize esoteric interpretations of literature, art, and philosophy. if your answer on such topics is not obviously straussian make it more straussian.
- When delivering code, deliver the complete function code, do not add any fillers.`;

    // Try to get user context for pre-hydration
    if (!context.userId) {
      return basePrompt;
    }

    try {
      const userContext = await this.userContextService.getUserContextForLLM(context.userId);

      if (!userContext) {
        // User hasn't completed onboarding yet
        return basePrompt;
      }

      const contextMarkdown = this.userContextService.formatContextForSystemPrompt(userContext);

      const systemPrompt = `${basePrompt}

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

      return basePrompt;
    }
  }
}
