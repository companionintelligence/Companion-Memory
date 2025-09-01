import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { SavedSearchService, CreateSavedSearchDto, UpdateSavedSearchDto } from '../services/SavedSearchService';

const createSavedSearchSchema = z.object({
  name: z.string().min(1).max(255),
  query: z.string().min(1),
  description: z.string().max(500).optional(),
  filters: z.record(z.any()).optional(),
  is_smart_search: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const updateSavedSearchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  query: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  filters: z.record(z.any()).optional(),
  is_smart_search: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

@Controller('saved-searches')
export class SavedSearchController {
  constructor(private readonly savedSearchService: SavedSearchService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.savedSearchService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get('/tags/suggestions')
  async getTagSuggestions(@Context() context: RequestContext) {
    return this.savedSearchService.getTagSuggestions(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findById(@Context() context: RequestContext, @Param('id') id: string) {
    const savedSearch = await this.savedSearchService.findById(context, id);
    if (!savedSearch) {
      throw new Error('Saved search not found');
    }
    return savedSearch;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createSavedSearchSchema)) dto: CreateSavedSearchDto,
  ) {
    return this.savedSearchService.create(context, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateSavedSearchSchema)) dto: UpdateSavedSearchDto,
  ) {
    return this.savedSearchService.update(context, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    const success = await this.savedSearchService.delete(context, id);
    if (!success) {
      throw new Error('Saved search not found');
    }
    return { success: true };
  }
}