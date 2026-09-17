import { Body, ConflictException, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { LlmEndpointLockedError, LlmEndpointService } from '../services/LlmEndpointService';

const updateSchema = z
  .object({
    backend: z.enum(['ollama', 'openai_compatible']),
    port: z.coerce.number().int().min(1).max(65535),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .refine((value) => !(value.apiKey && value.clearApiKey), {
    message: 'apiKey and clearApiKey cannot be used together',
    path: ['clearApiKey'],
  });

@Controller('llm')
export class LlmEndpointController {
  constructor(private readonly llmEndpointService: LlmEndpointService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('endpoint')
  @HttpCode(200)
  getEndpoint() {
    return this.llmEndpointService.getView();
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('endpoint/preflight')
  @HttpCode(200)
  preflightEndpoint() {
    return this.llmEndpointService.preflight();
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch('endpoint')
  @HttpCode(200)
  updateEndpoint(@Body(new ValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    try {
      return this.llmEndpointService.update(body);
    } catch (error) {
      if (error instanceof LlmEndpointLockedError) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}
