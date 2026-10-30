import { Module } from '@nestjs/common';

import { ModelRoutingModule } from '@ci/domains/model-routing';
import { ToolsModule } from '@ci/domains/tools';

import { ChatModelPreferenceModule } from './chat-model-preference.module';
import { LlmEndpointModule } from './llm-endpoint.module';
import { OllamaService } from './services/OllamaService';
import { ResidencyPlannerService } from './services/ResidencyPlannerService';

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
  imports: [ToolsModule, ModelRoutingModule, ChatModelPreferenceModule, LlmEndpointModule],
  providers: [ResidencyPlannerService, OllamaService],
  exports: [OllamaService, LlmEndpointModule, ResidencyPlannerService, ChatModelPreferenceModule],
})
export class LlmCoreModule {}
