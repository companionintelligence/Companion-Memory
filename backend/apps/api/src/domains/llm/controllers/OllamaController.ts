import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ToolCall } from 'ollama';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { Channel, FrameEncoder } from '@ci/common/rpc';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';

import { MessageService } from '../services/MessageService';
import { OllamaService } from '../services/OllamaService';
import { ThreadService } from '../services/ThreadService';
import type { OllamaModel, PromptInput } from '../types';

const promptSchema = z.object({
  prompt: z.string(),
  model: z.optional(z.string()),
  threadId: z.string().nullable().optional(),
  enableTools: z.boolean().default(false),
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
    const resolvedModel = await this.validateModel(context, input.model);

    let threadId: string;

    if (input.threadId != null) {
      const threadExists = await this.threadService.exists(context, input.threadId);

      if (!threadExists) {
        throw new NotFoundException('Thread not found');
      }

      threadId = input.threadId;
    } else {
      const thread = await this.threadService.create(context, {
        model: resolvedModel.model,
      });

      threadId = thread.id;

      await this.eventService.send(Events.CHAT_SUMMARIZATION, {
        ownerId: context.userId as string,
        threadId,
      });
    }

    // Create a message for the user prompt
    const promptMessage = await this.messageService.create(context, {
      model: resolvedModel.model,
      role: 'user',
      content: input.prompt,
      mimetype: 'text/markdown', // TODO: Make this more flexible.
      canceled: false,
      threadId,
    });

    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Thread-Id': threadId,
    });
    res.flushHeaders?.();

    const abortController = new AbortController();
    const signal = abortController.signal;

    res.on('close', () => {
      if (!signal.aborted) {
        abortController.abort();
      }
    });

    const messages = await this.messageService.findByThread(context, threadId);

    const inputMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls && { tool_calls: message.toolCalls as unknown as ToolCall[] }),
    }));

    const stream = await this.ollamaService.chatStream(context, inputMessages, {
      model: resolvedModel.model,
      signal,
      enableTools: input.enableTools,
      enableThinking: true,
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
          model: resolvedModel.model,
          role: message.role,
          content: message.content,
          canceled: i === stream.messages.length - 1 && signal.aborted,
          threadId,
          ...(message.tool_calls && {
            toolCalls: message.tool_calls as unknown[] as Record<string, unknown>[],
          }),
          promptMessageId: promptMessage.id,
        });
      }

      res.end();
    }
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

    const result = await this.ollamaService.chat(context, messagesInput);
    const summary = result.message.content;

    await this.threadService.update(context, thread.id, {
      name: summary,
    });

    this.logger.log('Processed chat summarization event', {
      payload,
      summary: result.message.content,
    });
  }

  private async validateModel(context: RequestContext, model: string | undefined): Promise<OllamaModel> {
    try {
      return this.ollamaService.validateModel(context, model);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
