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
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { ToolsModule } from '@ci/domains/tools';

import { OllamaController } from './controllers/OllamaController';
import { AnswerInferenceCron } from './cron/AnswerInferenceCron';
import { LlmInvocationEntity } from './entities/LlmInvocationEntity';
import { ImageDescriptionListener } from './listeners/ImageDescriptionListener';
import { InventoryListener } from './listeners/InventoryListener';
import { OllamaProvider } from './providers/OllamaProvider';
import { LlmInvocationLogger } from './services/LlmInvocationLogger';
import { LlmRouter } from './services/LlmRouter';
import { OllamaService } from './services/OllamaService';

/**
 * @internal
 */
@Module({
  imports: [
    ConversationModule,
    EventsModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    ToolsModule,
    TypeOrmModule.forFeature([LlmInvocationEntity]),
  ],
  providers: [
    AnswerInferenceCron,
    AnswerInferenceCron,
    ImageDescriptionListener,
    InventoryListener,
    OllamaService,
    // Plan 04 — provider-agnostic LLM seam. OllamaProvider wraps the same
    // `ollama` SDK the legacy OllamaService uses; LlmRouter dispatches by
    // task/policy. Future providers (Anthropic, OpenAI, OpenRouter) register
    // themselves here when the user has provider_keys configured.
    OllamaProvider,
    LlmInvocationLogger,
    LlmRouter,
  ],
  controllers: [OllamaController],
  exports: [LlmRouter],
})
export class LLMModule {}

export { LlmRouter } from './services/LlmRouter';
export type {
  LlmProvider,
  LlmTask,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  EmbedOptions,
} from './providers/LlmProvider';
export { OllamaProvider } from './providers/OllamaProvider';
export { DEFAULT_MODEL_POLICIES } from './policy/ModelPolicy';
export type { ModelPolicy, ModelPreference, PiiEgress } from './policy/ModelPolicy';
