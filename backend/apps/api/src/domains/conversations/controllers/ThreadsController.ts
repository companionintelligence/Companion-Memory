import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Body,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { CreateThreadDto } from '@ci/domains/conversations/types';

import { MessageService } from '../services/MessageService';
import { ThreadService } from '../services/ThreadService';

export const includeMessagesSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v !== 'false');

const createThreadSchema = z.object({
  name: z.string().optional(),
  model: z.string(),
  description: z.string().optional(),
  userId: z.string().optional(),
});

@Controller('threads')
export class ThreadsController {
  constructor(
    private readonly messageService: MessageService,
    private readonly threadService: ThreadService,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async post(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createThreadSchema)) input: CreateThreadDto,
  ) {
    const serviceContext = toServiceContext(context);

    return this.threadService.create(serviceContext, input);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    const threads = await this.threadService.findAll(serviceContext);

    return threads;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  async findOne(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Query('includeMessages', new ValidationPipe(includeMessagesSchema)) includeMessages: boolean,
  ) {
    const serviceContext = toServiceContext(context);

    const thread = await this.threadService.findById(serviceContext, id);

    if (thread == null) {
      throw new NotFoundException();
    }

    if (!includeMessages) {
      return thread;
    }

    const messages = await this.messageService.findByThreadId(serviceContext, thread.id);

    return {
      ...thread,
      messages,
    };
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    await this.threadService.softRemove(serviceContext, id);
  }
}
