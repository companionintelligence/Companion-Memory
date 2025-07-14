import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';

import { MessageService } from '../services/MessageService';
import { OllamaService } from '../services/OllamaService';
import { ThreadService } from '../services/ThreadService';
import type { OllamaModel, PromptInput, MediaAnalysisInput } from '../types';

const promptSchema = z.object({
  prompt: z.string(),
  model: z.optional(z.string()),
  threadId: z.string().nullable().optional(),
});

const mediaAnalysisSchema = z.object({
  model: z.optional(z.string()),
  analysisType: z.enum(['people', 'places', 'objects', 'comprehensive']),
  includeMetadata: z.optional(z.boolean()),
  threadId: z.string().nullable().optional(),
});

@Controller('llm')
export class OllamaController {
  private logger = new LoggerService(OllamaController.name);

  constructor(
    private readonly eventService: EventService,
    private readonly messageService: MessageService,
    private readonly ollamaService: OllamaService,
    private readonly threadService: ThreadService,
  ) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('models')
  async listModels(@Context() context: RequestContext) {
    return await this.ollamaService.getAvailableModels(context);
  }

  @UseGuards(AuthGuard('jwt'))
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

    const prompt = await this.messageService.create(context, {
      model: resolvedModel.model,
      text: input.prompt,
      mimetype: 'text/markdown', // TODO: Make this more flexible.
      prompt: true,
      canceled: false,
      threadId,
    });

    // Pre-create the message that will be updated after the stream
    // terminates with more content and resolution.
    const llmResponse = await this.messageService.create(context, {
      model: resolvedModel.model,
      // text -> We are updating this after the stream terminates
      // mimetype // TODO: Infer this from the content stream
      prompt: false,
      // canceled -> We are updating this after the stream terminates
      threadId,
      promptMessageId: prompt.id,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Thread-Id', threadId);
    res.setHeader('X-Prompt-Id', prompt.id);
    res.setHeader('X-Response-Id', llmResponse.id);

    const abortController = new AbortController();
    const signal = abortController.signal;

    res.on('close', () => {
      if (!signal.aborted) {
        abortController.abort();
      }
    });

    const messages = await this.messageService.findByThread(context, threadId);
    const filteredMessages = messages.filter((message) => message.id !== llmResponse.id);

    const stream = await this.ollamaService.chatStream(context, filteredMessages, {
      model: resolvedModel.model,
      signal,
    });

    try {
      for await (const chunk of stream) {
        if (chunk.message) {
          // TODO: Handle other properties on `chunk.message`.
          //   chunk.message.images?
          //   chunk.message.role
          //   chunk.message.tool_calls?
          res.write(chunk.message.content);
        }

        if (chunk.done) {
          this.logger.log('Ollama prompt evaluation completed', {
            model: chunk.model,
            totalDuration: chunk.total_duration ? chunk.total_duration / 1_000_000 : undefined,
            loadDuration: chunk.load_duration ? chunk.load_duration / 1_000_000 : undefined,
            evalDuration: chunk.prompt_eval_duration ? chunk.prompt_eval_duration / 1_000_000 : undefined,
            promptCount: chunk.prompt_eval_count,
            evalCount: chunk.eval_count,
            doneReason: chunk.done_reason,
          });
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this.logger.log('Client disconnected, aborted upstream Ollama request.');
      } else {
        this.logger.error('Error proxying Ollama stream:', err as Error);
      }
    } finally {
      await this.messageService.update(context, llmResponse.id, {
        text: stream.buffer,
        canceled: signal.aborted,
      });

      res.end();
    }
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('analyze-media')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } })) // 100MB limit
  async analyzeMedia(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(mediaAnalysisSchema)) input: MediaAnalysisInput,
    @UploadedFile() file: any, // Using any to avoid Express namespace issues
  ) {
    if (!file) {
      throw new BadRequestException('File is required for media analysis');
    }

    // Validate that we have a supported media type
    const mediaType = this.ollamaService.detectMediaType(file.mimetype);
    if (mediaType === 'unsupported') {
      throw new BadRequestException(
        `Unsupported media type: ${file.mimetype}. Supported types: image/*, video/*, audio/*`
      );
    }

    try {
      const result = await this.ollamaService.analyzeMedia(
        context,
        file.buffer,
        file.mimetype,
        input,
      );

      this.logger.log('Media analysis completed', {
        fileSize: file.size,
        mimetype: file.mimetype,
        analysisType: input.analysisType,
        processingTimeMs: result.processingTimeMs,
      });

      return result;
    } catch (error) {
      this.logger.error('Media analysis failed', error as Error);
      throw new BadRequestException(`Media analysis failed: ${(error as Error).message}`);
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
        prompt: true,
        text: 'Please summarize all of the following messages I will send you in 10 words or less. Please ONLY give me your summary. Please do not use punctuation.',
      },
      ...messages.map((message) => ({
        prompt: true,
        text: message.text,
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
