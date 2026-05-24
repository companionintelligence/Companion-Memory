import { Module } from '@nestjs/common';

import { EmbeddingGenerationService } from './services/EmbeddingGenerationService';

@Module({
  providers: [EmbeddingGenerationService],
  exports: [EmbeddingGenerationService],
})
export class EmbeddingModule {}

export { EmbeddingGenerationService };
