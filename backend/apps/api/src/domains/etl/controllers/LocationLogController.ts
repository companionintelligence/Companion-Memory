import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import type { RequestContext } from '@ci/common/types';

import { LocationLogService } from '../services/LocationLogService';
import type { CreateLocationLogDto } from '../types';

const createLocationLogSchema = z.object({
  content: z.any(),
});

@Controller('etl/locations')
export class LocationLogController {
  constructor(private readonly locationLogService: LocationLogService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createLocationLogSchema)) input: CreateLocationLogDto,
  ) {
    return this.locationLogService.create(context, input);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.locationLogService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.locationLogService.findOne(context, id);
  }
}
