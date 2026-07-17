/**
 * This module serves as the primary interface for interacting with the Large Language Model (LLM)
 * provided by Ollama. It is responsible for sending prompts, managing context from conversations,
 * and integrating LLM-powered functionalities like tool usage across the application.
 *
 * ### Key Components:
 * - **OllamaService**: The core service that encapsulates the logic for communicating with the
 *   Ollama API. It handles model selection, prompt construction, and response parsing.
 * - **OllamaController**: Provides REST API endpoints for interaction with the LLM.
 *
 * ### Module Integration:
 * - **`ConversationModule`**: To access conversation history, providing context for LLM prompts.
 * - **`EventsModule`**: For handling asynchronous LLM-related tasks.
 * - **`FilesModule`**: To enable the LLM to interact with or process file-based data.
 * - **`ToolsModule`**: Provides the LLM with a set of tools it can call to perform actions.
 *
 * @module LLMModule
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { ToolsModule } from '@ci/domains/tools';

import { OllamaController } from './controllers/OllamaController';
import { AnswerInferenceCron } from './cron/AnswerInferenceCron';
import { AnswerInferenceListener } from './listeners/AnswerInferenceListener';
import { CvDetectionsListener } from './listeners/CvDetectionsListener';
import { ImageDescriptionListener } from './listeners/ImageDescriptionListener';
import { InventoryListener } from './listeners/InventoryListener';
import { OllamaService } from './services/OllamaService';

/**
 * @internal
 */
@Module({
  imports: [ConversationModule, EventsModule, FilesModule, IntelligenceModule, MemoryModule, ToolsModule],
  providers: [
    AnswerInferenceCron,
    AnswerInferenceListener,
    CvDetectionsListener,
    ImageDescriptionListener,
    InventoryListener,
    OllamaService,
  ],
  controllers: [OllamaController],
  exports: [OllamaService],
})
export class LLMModule {}

export { OllamaService };
export { PROMPT_MODEL } from './services/OllamaService';
export { CV_DETECTION_LINKED_TABLE } from './listeners/CvDetectionsListener';
export {
  CvDetectionsCapturedEvent,
  type CvDetection,
  type CvDetectionKind,
  type CvBBoxNormalized,
  type CvDetectionsCapturedPayload,
} from './events';
