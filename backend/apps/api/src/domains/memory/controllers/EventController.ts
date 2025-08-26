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

import { EventService } from '../services/EventService';
import { CreateEventDto, UpdateEventDto } from '../types';

const createEventSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  source_data: z
    .object({
      related_objects: z.array(z.string()),
    })
    .optional(),
  connection_id: z.string().optional(),
});

const updateEventSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  source_data: z
    .object({
      related_objects: z.array(z.string()),
    })
    .optional(),
  connection_id: z.string().optional(),
});

@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Req() req: Request,
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createEventSchema)) input: CreateEventDto,
  ) {
    try {
      if (context.userId) {
        input.user = { id: context.userId };
      }

      return await this.eventService.create(input);
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
    return this.eventService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Context() context: RequestContext) {
    return this.eventService.findOne(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe(updateEventSchema)) input: UpdateEventDto,
    @Context() context: RequestContext,
  ) {
    try {
      return await this.eventService.update(context, id, input);
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
    return this.eventService.remove(id);
  }
}
