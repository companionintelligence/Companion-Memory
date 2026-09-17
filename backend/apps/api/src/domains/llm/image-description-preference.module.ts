import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';

import { LlmCoreModule } from './core.module';
import { ImageDescriptionPreferenceService } from './services/ImageDescriptionPreferenceService';

/**
 * Tiny module so vision listeners and Settings can share the describe-images
 * preference without LLMModule ↔ PersonalizationModule circular imports.
 *
 * Also imports `LlmCoreModule` for `OllamaService.resolveVisionModel` — safe
 * because `LlmCoreModule` has no import edge back to this module or to
 * PersonalizationModule (it depends only on Tools/ModelRouting/its own
 * ChatModelPreferenceModule), so this stays a DAG, not a cycle.
 */
@Module({
  imports: [MemoryModule, EventsModule, LlmCoreModule],
  providers: [ImageDescriptionPreferenceService],
  exports: [ImageDescriptionPreferenceService],
})
export class ImageDescriptionPreferenceModule {}

export { ImageDescriptionPreferenceService } from './services/ImageDescriptionPreferenceService';
