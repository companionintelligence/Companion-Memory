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
  UnauthorizedException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import { PgErrorCode } from '@ci/common/constants';
import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';
import { createContentSchema } from '@ci/domains/memory/controllers/ContentController';
import { ContentService } from '@ci/domains/memory/services/ContentService';

import { EventService } from '../services/EventService';
import { CreateEventDto, UpdateEventDto, Content, Event } from '../types';

const createEventSchemaRoot = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  external_id: z.string().optional(),
  source_url: z.string().optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  source_data: z
    .object({
      related_objects: z.array(z.string()),
    })
    .optional(),
  content: z.array(createContentSchema).optional(),
  connection_id: z.string().optional(),
});

const createEventSchema = z.union([createEventSchemaRoot, z.array(createEventSchemaRoot)]);

const updateEventSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  external_id: z.string().optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  source_url: z.string().optional(),
  source_data: z
    .object({
      related_objects: z.array(z.string()),
    })
    .optional(),
  content: z.array(createContentSchema).optional(),
  connection_id: z.string().optional(),
});

@Controller('events')
export class EventController {
  constructor(
    private readonly eventService: EventService,
    private readonly contentService: ContentService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Req() req: Request,
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createEventSchema)) input: CreateEventDto | CreateEventDto[],
  ) {
    if (!context.userId) {
      throw new UnauthorizedException();
    }

    try {
      const isSingle = !Array.isArray(input);
      let dataArray: CreateEventDto[] = isSingle ? [input] : input;

      dataArray = dataArray.map((item) => {
        item.user = { id: context.userId! };

        return item;
      });

      const returned = await Promise.all(
        dataArray.map(async (item) => {
          const { content: contentInput, ...event } = item;
          const newEvent = (await this.eventService.create(context, event)) as Event;

          if (contentInput) {
            const contentInputForEvent = contentInput.map((input) => ({
              ...input,
              event: { id: newEvent.id },
            }));
            const contentArray = (await this.contentService.create(
              context,
              contentInputForEvent,
            )) as Content[];

            return this.eventService.update(context, newEvent.id, {
              source_data: {
                related_objects: contentArray.map((content) => `content_${content.id}`),
              },
            });
          } else {
            return newEvent;
          }
        }),
      );

      return isSingle ? returned[0] : returned;
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
