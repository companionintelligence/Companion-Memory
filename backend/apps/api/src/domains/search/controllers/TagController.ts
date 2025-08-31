import {
  ConflictException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  HttpCode,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import { PgErrorCode } from '@ci/common/constants';
import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { TagService } from '../services/TagService';
import { CreateTagDto, UpdateTagDto } from '../types';

const createTagSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100, 'Label must be at most 100 characters'),
});

const updateTagSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100, 'Label must be at most 100 characters').optional(),
});

@Controller('tags')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createTagSchema)) input: CreateTagDto,
  ) {
    try {
      return await this.tagService.create(context, input);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new ConflictException('Tag with this label already exists');
      }

      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.tagService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Context() context: RequestContext) {
    const tag = await this.tagService.findOne(context, id);
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }

    return tag;
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe(updateTagSchema)) input: UpdateTagDto,
    @Context() context: RequestContext,
  ) {
    try {
      const result = await this.tagService.update(context, id, input);
      if (!result) {
        throw new NotFoundException('Tag not found');
      }

      return result;
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new ConflictException('Tag with this label already exists');
      }

      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Context() context: RequestContext) {
    const result = await this.tagService.remove(context, id);
    if (!result) {
      throw new NotFoundException('Tag not found');
    }
  }
}
