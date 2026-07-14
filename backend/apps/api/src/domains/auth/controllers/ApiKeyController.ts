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
import { CONNECT_KEY_NAME_PREFIX, type CreateApiKeyDto, type UpdateApiKeyDto } from '../types';

/**
 * `app:` is reserved for connection keys minted by the consent flow
 * (`app:<appName>:<store>`). Hub ownership is carried by recorded provenance, not by
 * this prefix, so a colliding name no longer hands a user's key to Hub machinery —
 * but keeping the namespaces distinct still matters: the settings UI badges connect
 * keys as Hub-managed, and a user-created `app:ci-hermes:ci-marketplace` would read as
 * one while behaving as a normal key. Reject the name at the door instead.
 */
const apiKeyName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.startsWith(CONNECT_KEY_NAME_PREFIX), {
    message: `Key names starting with "${CONNECT_KEY_NAME_PREFIX}" are reserved for connected apps`,
  });

const createApiKeySchema = z.object({
  name: apiKeyName,
  scopes: z.array(z.string()).optional(),
  expires_at: z.string().datetime().optional(),
});

// The name here is NOT refined: rejecting `app:` on the request body would also 400 a
// client echoing a key's own unchanged name (which the settings dialog always submits),
// making the grandfathered `app:`-named user keys this release unlocks impossible to
// edit. ApiKeyService.update enforces the reservation on an actual RENAME, where it
// can compare against the key's current name.
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
