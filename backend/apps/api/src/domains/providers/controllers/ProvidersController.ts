import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { ProviderService } from '../services/ProviderService';
import type { CreateProviderDto, UpdateProviderDto } from '../types';

const createProviderSchema = z.object({
  name: z.string().min(1, 'Name is required'),
});

const updateProviderSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
});

@Controller('providers')
export class ProvidersController {
  constructor(private readonly providerService: ProviderService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll() {
    return this.providerService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.providerService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body(new ValidationPipe(createProviderSchema)) input: CreateProviderDto) {
    return this.providerService.create(input);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe(updateProviderSchema)) input: UpdateProviderDto,
  ) {
    return this.providerService.update(id, input);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.providerService.delete(id);
  }
}
