import {
  ConflictException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import { PgErrorCode } from '@ci/common/constants';
import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { ContentService } from '../services/ContentService';
import { CreateContentDto, UpdateContentDto } from '../types';

const createContentSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  mimetype: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  user_id: z.string().optional(),
  event_id: z.string().optional(),
});

const updateContentSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  mimetype: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  user_id: z.string().optional(),
  event_id: z.string().optional(),
});

@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Req() req: Request,
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createContentSchema)) input: CreateContentDto,
  ) {
    try {
      if (context.userId) {
        input.user = { id: context.userId };
      }

      if (input.event_id) {
        input.event = { id: input.event_id };
      }

      return await this.contentService.create(input);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        // TODO: Obfuscate this error message? We're revealing DB details here.
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    return this.contentService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Context() context: RequestContext) {
    return this.contentService.findOne(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe(updateContentSchema)) input: UpdateContentDto,
    @Context() context: RequestContext,
  ) {
    try {
      return await this.contentService.update(context, id, input);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        // TODO: Obfuscate this error message? We're revealing DB details here.
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.contentService.remove(id);
  }
}
