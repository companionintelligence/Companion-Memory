import { Module } from '@nestjs/common';

import {
  EMBED_TIMEOUT_MESSAGE,
  EMBED_TIMEOUT_MS,
  EmbeddingGenerationService,
} from './services/EmbeddingGenerationService';

@Module({
  providers: [EmbeddingGenerationService],
  exports: [EmbeddingGenerationService],
})
export class EmbeddingModule {}

export { EmbeddingGenerationService, EMBED_TIMEOUT_MS, EMBED_TIMEOUT_MESSAGE };
export {
  embedSkipReason,
  isEmbeddable,
  isEmbeddableType,
  normalizeEmbeddableType,
  shouldEmbedType,
  type EmbeddableOptions,
  type SkipReason,
} from './embeddable';
