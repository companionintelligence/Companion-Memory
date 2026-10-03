import { Body, ConflictException, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { LlmEndpointLockedError, LlmEndpointService } from '../services/LlmEndpointService';

const updateSchema = z
  .object({
    backend: z.enum(['ollama', 'openai_compatible']),
    port: z.coerce.number().int().min(1).max(65535),
    /** OpenAI-compatible only: where the server mounts its API (`/v1`; Lemonade `/api/v1`). Ignored on Ollama. */
    basePath: z
      .string()
      .trim()
      .max(200)
      .regex(
        /^\/?[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*\/?$|^\/?$/,
        'basePath must be a plain URL path such as /v1 or /api/v1',
      )
      .optional(),
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

  // There is ONE inference endpoint per appliance: every user's prompts, embeddings and the
  // stored bearer go wherever this points. Repointing it is an administrator's decision, not
  // any signed-in household member's (the reads above stay open to everyone).
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
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
