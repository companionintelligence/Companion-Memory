/**
 * @module LLMModule
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { SearchNextModule } from '@ci/domains/search-next';
import { ToolsModule } from '@ci/domains/tools';

import { LlmEndpointController } from './controllers/LlmEndpointController';
import { OllamaController } from './controllers/OllamaController';
import { LlmCoreModule } from './core.module';
import { CvDetectionsListener } from './listeners/CvDetectionsListener';
import { ImageDescriptionListener } from './listeners/ImageDescriptionListener';
import { InventoryListener } from './listeners/InventoryListener';

/**
 * @internal
 */
@Module({
  imports: [
    LlmCoreModule,
    ConversationModule,
    EventsModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    SearchNextModule,
    ToolsModule,
  ],
  providers: [CvDetectionsListener, ImageDescriptionListener, InventoryListener],
  controllers: [OllamaController, LlmEndpointController],
  exports: [LlmCoreModule],
})
export class LLMModule {}

export { LlmCoreModule } from './core.module';
export { OllamaService } from './services/OllamaService';
export { PROMPT_MODEL, type ChatRequestContext } from './services/OllamaService';
export { estimateInferredAnswerConfidence } from './inferredAnswerConfidence';
export { CV_DETECTION_LINKED_TABLE } from './listeners/CvDetectionsListener';
export {
  CvDetectionsCapturedEvent,
  type CvDetection,
  type CvDetectionKind,
  type CvBBoxNormalized,
  type CvDetectionsCapturedPayload,
} from './events';
