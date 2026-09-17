import { Module } from '@nestjs/common';

import { MemoryModule } from '@ci/domains/memory';

import { ChatModelPreferenceService } from './services/ChatModelPreferenceService';

/**
 * Tiny module for the same reason {@link ImageDescriptionPreferenceModule} is
 * one: `LlmCoreModule` needs {@link ChatModelPreferenceService} inside
 * `OllamaService`, and `PersonalizationModule` needs it for the Settings
 * controller, but `PersonalizationModule` already imports `LlmCoreModule` —
 * so putting this service IN either of those two would be circular one way
 * or the other. A standalone module depending only on `MemoryModule` breaks
 * that: both sides import this, neither imports each other over it.
 */
@Module({
  imports: [MemoryModule],
  providers: [ChatModelPreferenceService],
  exports: [ChatModelPreferenceService],
})
export class ChatModelPreferenceModule {}

export { ChatModelPreferenceService } from './services/ChatModelPreferenceService';
