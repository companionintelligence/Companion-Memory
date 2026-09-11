import { Module } from '@nestjs/common';

import { ModelRoutingModule } from '@ci/domains/model-routing';
import { ToolsModule } from '@ci/domains/tools';

import { ChatModelPreferenceModule } from './chat-model-preference.module';
import { LlmEndpointService } from './services/LlmEndpointService';
import { OllamaService } from './services/OllamaService';

/**
 * Ollama client wiring without listeners that depend on personalization.
 *
 * `ChatModelPreferenceModule` is the one exception — like
 * `ImageDescriptionPreferenceModule`, it depends only on `MemoryModule`, so
 * importing it here does not reintroduce the personalization cycle this
 * module's own doc comment (above) exists to avoid. `OllamaService` needs it
 * to resolve a user's effective chat model.
 */
@Module({
  imports: [ToolsModule, ModelRoutingModule, ChatModelPreferenceModule],
  providers: [LlmEndpointService, OllamaService],
  exports: [OllamaService, LlmEndpointService],
})
export class LlmCoreModule {}
