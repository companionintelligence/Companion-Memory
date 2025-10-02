import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import type { RequestContext } from '@ci/common/types';

import { ContactLogService } from '../services/ContactLogService';
import type { CreateContactLogDto } from '../types';

const createContactLogSchema = z.object({
  content: z.any(),
});

@Controller('etl/contacts')
export class ContactLogController {
  constructor(private readonly contactLogService: ContactLogService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createContactLogSchema)) input: CreateContactLogDto,
  ) {
    return this.contactLogService.create(context, input);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.contactLogService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.contactLogService.findOne(context, id);
  }
}
