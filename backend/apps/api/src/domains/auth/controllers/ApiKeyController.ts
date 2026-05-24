import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { ApiKeyService } from '../services/ApiKeyService';
import type { CreateApiKeyDto, UpdateApiKeyDto } from '../types';

const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).optional(),
  expires_at: z.string().datetime().optional(),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  scopes: z.array(z.string()).optional(),
});

@Controller('keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createApiKeySchema)) input: CreateApiKeyDto,
  ) {
    const serviceContext = toServiceContext(context);

    return this.apiKeyService.create(serviceContext, input);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.apiKeyService.findAllByUser(serviceContext);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') keyId: string) {
    const serviceContext = toServiceContext(context);

    const key = await this.apiKeyService.findOneByUser(serviceContext, keyId);

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    return key;
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') keyId: string,
    @Body(new ValidationPipe(updateApiKeySchema)) input: UpdateApiKeyDto,
  ) {
    const serviceContext = toServiceContext(context);

    const key = await this.apiKeyService.update(serviceContext, keyId, input);

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    return key;
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') keyId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const removed = await this.apiKeyService.remove(serviceContext, keyId);

    if (!removed) {
      throw new NotFoundException('API key not found');
    }
  }
}
