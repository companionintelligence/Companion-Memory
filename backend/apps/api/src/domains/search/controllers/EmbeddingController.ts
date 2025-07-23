import { Controller, Get, HttpCode, Post, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { EmbeddingService } from '../services/EmbeddingService';

const vectorInputSchema = z.object({
  input: z.string(),
});

@Controller('embeddings')
export class EmbeddingController {
  constructor(private readonly embeddingService: EmbeddingService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getEmbeddings(@Context() context: RequestContext) {
    return this.embeddingService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Post('/search')
  @HttpCode(200)
  async searchEmbeddings(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(vectorInputSchema)) input: { input: string },
  ) {
    return this.embeddingService.findNearest(context, input.input);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(200)
  async calculateEmbedding(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(vectorInputSchema)) input: { input: string },
  ) {
    return this.embeddingService.indexText(context, input.input);
  }
}
