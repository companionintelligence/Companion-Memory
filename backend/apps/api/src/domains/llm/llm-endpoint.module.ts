import { Module } from '@nestjs/common';

import { LlmEndpointService } from './services/LlmEndpointService';

/**
 * The resolved LLM endpoint on its own, so a module that must not pull in
 * `LlmCoreModule` can still ask where inference lives.
 *
 * `EmbeddingModule` is the one that needs this. It cannot import `LlmCoreModule`
 * — `ToolsModule` sits under that, and the tool modules import the search
 * modules, which import `EmbeddingModule` — and the embedder has to follow the
 * chat backend to embed on an OpenAI-compatible engine (see
 * `EmbeddingGenerationService.resolveTarget`). `LlmEndpointService` depends on
 * nothing but the logger, so it is the one provider here; `LlmCoreModule`
 * imports and re-exports this module, so every existing importer of
 * `LlmEndpointService` still gets the same single instance.
 */
@Module({
  providers: [LlmEndpointService],
  exports: [LlmEndpointService],
})
export class LlmEndpointModule {}
